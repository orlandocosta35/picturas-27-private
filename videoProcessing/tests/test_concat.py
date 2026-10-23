"""UC-VID-005 tests; requires Flask, FFmpeg and FFprobe, not server.py."""

import base64
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from flask import Flask
from use_cases.concat import (ConcatError, ConcatService, create_concat_blueprint, describe,
                    inspect_source, prepare_inputs, probe_input, write_list_file)
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import functools
from utils.common import VideoContext, VideoError, VideoHooks
from utils.media import audio_notice, select_audio


def make_video(path, seconds=2, size="160x96", audio=True, rate=12, variable=False,
               sample_rate=48000, audio_tracks=1):
    command = ["ffmpeg", "-nostdin", "-loglevel", "error", "-y",
               "-f", "lavfi", "-i", f"testsrc=duration={seconds}:size={size}:rate={rate}"]
    if audio:
        for track in range(audio_tracks):
            command += ["-f", "lavfi", "-i",
                        f"sine=frequency={440 * (track + 1)}:duration={seconds}:sample_rate={sample_rate}"]
        command += ["-map", "0:v"] + [arg for track in range(audio_tracks)
                                      for arg in ("-map", f"{track + 1}:a")]
        command += ["-c:a", "aac", "-ac", "2"]
    command += ["-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p",
                "-video_track_timescale", "12800", "-shortest"]
    if variable:
        # Retira frames a meio, como um telemóvel faz com a imagem parada: FPS variável.
        command += ["-vf", "select='not(between(n,5,15))'", "-fps_mode", "vfr"]
    command.append(str(path))
    subprocess.run(command, check=True)
    return path


class Ledger:
    """Quota falsa com a regra do users: o Free só tem uma reserva ativa."""

    def __init__(self, reject=False):
        self.reserved, self.committed, self.aborted = set(), set(), set()
        self.reject = reject
        self.lock = threading.Lock()

    def accept(self, context, task):
        with self.lock:
            if self.reject or (context.profile == "free" and self.reserved):
                raise VideoError("ACTIVE_TASK_LIMIT", "A video task is already active.", 409)
            self.reserved.add(task["id"])

    def complete(self, context, task, output):
        assert output.is_file()
        with self.lock:
            self.reserved.discard(task["id"])
            self.committed.add(task["id"])

    def abort(self, context, task):
        with self.lock:
            self.reserved.discard(task["id"])
            self.committed.discard(task["id"])
            self.aborted.add(task["id"])


class Fixtures(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixtures = tempfile.TemporaryDirectory()
        root = Path(cls.fixtures.name)
        cls.a = make_video(root / "a.mp4", seconds=2)
        cls.b = make_video(root / "b.mp4", seconds=3)
        cls.big = make_video(root / "big.mp4", size="320x240")
        cls.silent = make_video(root / "silent.mp4", audio=False)
        cls.fps30 = make_video(root / "fps30.mp4", rate=30)
        cls.quote = make_video(root / "it's.mp4")
        cls.variable = make_video(root / "variable.mp4", seconds=3, variable=True)
        cls.khz44 = make_video(root / "khz44.mp4", sample_rate=44100)
        cls.two_tracks = make_video(root / "two_tracks.mp4", audio_tracks=2)

    @classmethod
    def tearDownClass(cls):
        cls.fixtures.cleanup()


class ValidationTests(Fixtures):
    def code(self, paths, profile="free"):
        with self.assertRaises(ConcatError) as error:
            prepare_inputs(paths, profile)
        return error.exception

    def test_requires_at_least_two_videos(self):
        self.assertEqual(self.code([self.a]).code, "TOO_FEW_VIDEOS")

    def test_free_is_limited_to_five_and_premium_to_twenty(self):
        error = self.code([self.a] * 6)
        self.assertEqual(error.code, "TOO_MANY_VIDEOS")
        self.assertTrue(error.details["suggestPremium"])
        self.assertEqual(len(prepare_inputs([self.a] * 6, "premium")[0]), 6)
        self.assertFalse(self.code([self.a] * 21, "premium").details["suggestPremium"])

    def test_anonymous_profile_is_rejected(self):
        self.assertEqual(self.code([self.a, self.b], "anonymous").status, 403)

    def test_incompatible_videos_ask_for_conversion_naming_the_video_and_field(self):
        cases = [(self.big, "width"), (self.silent, "audio"), (self.fps30, "r_frame_rate")]
        for other, field in cases:
            with self.subTest(field=field):
                error = self.code([self.a, other])
                self.assertEqual((error.code, error.status), ("CONVERSION_REQUIRED", 409))
                self.assertEqual((error.details["index"], error.details["field"]), (1, field))
                # O alvo da conversão é o formato do primeiro vídeo.
                target = error.details["target"]
                self.assertEqual((target["width"], target["height"], target["container"]), (160, 96, "mp4"))

    def test_confirmed_conversion_returns_the_target_and_compatible_videos_copy(self):
        inputs, target = prepare_inputs([self.a, self.big], "free", convert=True)
        self.assertEqual((len(inputs), target["width"], target["fpsValue"]), (2, 160, 12))
        self.assertIsNone(prepare_inputs([self.a, self.b], "free", convert=True)[1])

    def test_videos_without_audio_are_compatible_with_each_other(self):
        self.assertEqual(len(prepare_inputs([self.silent, self.silent], "free")[0]), 2)

    def test_first_readable_audio_track_is_used_and_the_others_reported(self):
        info = probe_input(self.two_tracks)
        self.assertEqual(info.audio_index, 1)
        self.assertIn("2 audio tracks", info.notice)
        self.assertIsNone(probe_input(self.a).notice)

    def test_select_audio_skips_tracks_ffmpeg_cannot_read(self):
        streams = [{"index": 0, "codec_type": "audio", "codec_name": "unknown"},
                   {"index": 1, "codec_type": "video", "codec_name": "h264"},
                   {"index": 2, "codec_type": "audio", "codec_name": "aac"}]
        self.assertEqual(select_audio(streams), (streams[2], 1))
        self.assertEqual(select_audio(streams[:2]), (None, 1))
        self.assertIn("cannot be read", audio_notice(None, 1))

    def test_unreadable_input_reports_its_position(self):
        broken = Path(self.fixtures.name) / "broken.mp4"
        broken.write_bytes(b"not a video")
        error = self.code([self.a, broken])
        self.assertEqual((error.code, error.details["index"]), ("UNREADABLE_VIDEO", 1))

    def test_audio_mismatch_names_the_audio_field(self):
        error = self.code([self.a, self.khz44])
        self.assertEqual(error.details["field"], "audio_sample_rate")
        self.assertIn("audio sample rate", error.details["detail"])

    def test_describe_exposes_metadata_and_the_rn7_signature(self):
        info = describe(probe_input(self.a))
        self.assertEqual((info["width"], info["height"], info["fps"]), (160, 96, 12.0))
        self.assertEqual((info["videoCodec"], info["audioCodec"], info["hasAudio"]), ("h264", "aac", True))
        self.assertAlmostEqual(info["duration"], 2, delta=0.1)
        fields = [entry["field"] for entry in info["compatibility"]]
        self.assertEqual(fields[:2], ["container", "codec_name"])
        self.assertIn("audio_sample_rate", fields)
        # A interface compara assinaturas: compatíveis são iguais, incompatíveis não.
        same = describe(probe_input(self.b))["compatibility"]
        other = describe(probe_input(self.big))["compatibility"]
        self.assertEqual(same, info["compatibility"])
        self.assertNotEqual(other, info["compatibility"])
        self.assertFalse(describe(probe_input(self.silent))["hasAudio"])

    def test_inspect_source_reads_over_http_with_credentials(self):
        received = []

        class Handler(SimpleHTTPRequestHandler):
            def do_GET(self):
                received.append(self.headers.get("Authorization"))
                if self.headers.get("Authorization") != "Bearer secret":
                    self.send_error(401)
                    return
                super().do_GET()

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(
            Handler, directory=str(Path(self.fixtures.name))))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            url = f"http://127.0.0.1:{server.server_port}/a.mp4"
            remote = inspect_source(url, {"Authorization": "Bearer secret"})
            self.assertEqual(describe(remote)["compatibility"],
                             describe(probe_input(self.a))["compatibility"])
            self.assertEqual(remote.size, self.a.stat().st_size)
            self.assertIn("Bearer secret", received)
            with self.assertRaises(ConcatError) as error:
                inspect_source(url, {"Authorization": "Bearer wrong"})
            self.assertEqual(error.exception.code, "UNREADABLE_VIDEO")
        finally:
            server.shutdown()
            server.server_close()

    def test_list_file_escapes_quotes_in_paths(self):
        target = Path(self.fixtures.name) / "list.txt"
        write_list_file([probe_input(self.quote)], target)
        self.assertIn("it'\\''s.mp4", target.read_text())


class ServiceTests(Fixtures):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.ledger = Ledger()
        self.context = VideoContext("alice", "free", "project-a")
        self.service = ConcatService(self.temp.name, VideoHooks(
            self.ledger.accept, self.ledger.complete, self.ledger.abort))
        app = Flask(__name__)
        app.config["TESTING"] = True
        self.library_calls = []
        def library(context):
            self.library_calls.append(context)
            return [{"projectId": "p1", "name": "a.mp4", **describe(probe_input(self.a))}]
        app.register_blueprint(create_concat_blueprint(self.service, lambda: self.context, library))
        self.client = app.test_client()

    def tearDown(self):
        self.service.close()
        self.temp.cleanup()

    def submit(self, *paths, convert=False):
        files = [(io.BytesIO(path.read_bytes()), path.name) for path in paths]
        data = {"videos": files, **({"convert": "true"} if convert else {})}
        return self.client.post("/video/concat", data=data)

    def wait(self, task_id, final=("completed", "failed", "cancelled")):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            task = self.client.get(f"/video/concat/tasks/{task_id}").get_json()
            if task.get("status") in final:
                return task
            time.sleep(0.05)
        self.fail(f"Task did not finish: {task}")

    def test_concatenates_in_order_publishes_and_commits_quota(self):
        response = self.submit(self.b, self.a)
        self.assertEqual(response.status_code, 202, response.get_json())
        created = response.get_json()
        self.assertEqual(created["status"], "queued")
        self.assertEqual([i["name"] for i in created["inputs"]], ["b.mp4", "a.mp4"])
        self.assertEqual(created["downloadName"], "b_joined.mp4")
        self.assertNotIn("_userId", created)

        task = self.wait(created["id"])
        self.assertEqual(task["status"], "completed", task)
        self.assertEqual(task["progress"], 100)
        self.assertAlmostEqual(task["result"]["duration"], 5, delta=0.2)
        self.assertEqual((task["result"]["width"], task["result"]["height"]), (160, 96))
        self.assertTrue(task["result"]["hasAudio"])
        self.assertEqual(self.ledger.committed, {created["id"]})
        self.assertFalse(self.ledger.reserved)

        download = self.client.get(f"/video/concat/tasks/{created['id']}/download")
        self.assertEqual(download.status_code, 200)
        self.assertGreater(len(download.data), 0)
        download.close()
        # Só ficam o estado e o resultado; entradas e lista são apagadas.
        remaining = {p.name for p in (self.service.root / created["id"]).iterdir()}
        self.assertEqual(remaining, {"task.json", "result.mp4"})

    def test_library_route_returns_metadata_for_the_caller(self):
        response = self.client.get("/video/concat/library")
        self.assertEqual(response.status_code, 200)
        [item] = response.get_json()
        self.assertEqual((item["name"], item["width"], item["hasAudio"]), ("a.mp4", 160, True))
        self.assertEqual(self.library_calls, [self.context])
        self.context = VideoContext("alice", "anonymous", "project-a")
        self.assertEqual(self.client.get("/video/concat/library").status_code, 403)

    def test_invalid_selection_creates_no_task_nor_reservation(self):
        for paths, code in [((self.a,), "TOO_FEW_VIDEOS"), ((self.a, self.big), "CONVERSION_REQUIRED")]:
            with self.subTest(code=code):
                response = self.submit(*paths)
                self.assertIn(response.status_code, {400, 409})
                self.assertEqual(response.get_json()["code"], code)
        self.assertFalse(self.ledger.reserved | self.ledger.committed | self.ledger.aborted)
        self.assertEqual(list(self.service.root.iterdir()), [])

    def test_variable_fps_videos_are_concatenated(self):
        info = probe_input(self.variable)
        self.assertNotEqual(info.video["r_frame_rate"], subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
             "stream=avg_frame_rate", "-of", "csv=p=0", str(self.variable)],
            capture_output=True, text=True, check=True).stdout.strip())
        response = self.submit(self.variable, self.variable)
        self.assertEqual(response.status_code, 202, response.get_json())
        task = self.wait(response.get_json()["id"])
        self.assertEqual(task["status"], "completed", task)
        self.assertAlmostEqual(task["result"]["duration"], 2 * info.duration, delta=0.2)

    def test_confirmed_conversion_joins_different_videos(self):
        # Resolution, FPS e audio presence diferentes; o primeiro define o formato.
        response = self.submit(self.a, self.big, self.silent, self.fps30, convert=True)
        self.assertEqual(response.status_code, 202, response.get_json())
        created = response.get_json()
        self.assertEqual(created["mode"], "convert")
        task = self.wait(created["id"])
        self.assertEqual(task["status"], "completed", task)
        self.assertEqual((task["result"]["width"], task["result"]["height"]), (160, 96))
        self.assertAlmostEqual(task["result"]["fps"], 12, delta=0.01)
        self.assertTrue(task["result"]["hasAudio"])
        self.assertAlmostEqual(task["result"]["duration"], 8, delta=0.4)
        self.assertEqual(self.ledger.committed, {created["id"]})

    def test_videos_with_several_audio_tracks_are_copied_with_one_and_warned(self):
        response = self.submit(self.two_tracks, self.two_tracks)
        self.assertEqual(response.status_code, 202, response.get_json())
        created = response.get_json()
        self.assertEqual((created["mode"], len(created["warnings"])), ("copy", 2))
        task = self.wait(created["id"])
        self.assertEqual(task["status"], "completed", task)
        output = self.service.root / created["id"] / "result.mp4"
        streams = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type",
                                  "-of", "csv=p=0", str(output)],
                                 capture_output=True, text=True, check=True).stdout.split()
        self.assertEqual(sorted(streams), ["audio", "video"])

    def test_quota_rejection_does_not_start_processing(self):
        self.ledger.reject = True
        response = self.submit(self.a, self.b)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["code"], "ACTIVE_TASK_LIMIT")
        self.assertFalse(self.ledger.committed)

    def slow(self):
        # A cópia é quase instantânea; um processo lento deixa a tarefa ativa.
        patcher = patch("use_cases.concat.build_concat_command", return_value=["sleep", "30"])
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_free_profile_cannot_have_two_active_tasks(self):
        self.slow()
        first = self.submit(self.a, self.b)
        self.assertEqual(first.status_code, 202, first.get_json())
        second = self.submit(self.a, self.b)
        self.assertEqual(second.status_code, 409)
        self.client.delete(f"/video/concat/tasks/{first.get_json()['id']}")

    def test_cancel_releases_quota_and_removes_files(self):
        self.slow()
        task_id = self.submit(self.a, self.b).get_json()["id"]
        self.wait(task_id, final=("processing",))
        cancelled = self.client.delete(f"/video/concat/tasks/{task_id}")
        self.assertEqual(cancelled.status_code, 200)
        self.assertEqual(cancelled.get_json()["status"], "cancelled")
        self.assertEqual(self.wait(task_id)["status"], "cancelled")
        self.assertEqual(self.ledger.aborted, {task_id})
        self.assertFalse(self.ledger.committed)
        again = self.client.delete(f"/video/concat/tasks/{task_id}")
        self.assertEqual(again.status_code, 409)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and len(list((self.service.root / task_id).iterdir())) > 1:
            time.sleep(0.05)
        self.assertEqual([p.name for p in (self.service.root / task_id).iterdir()], ["task.json"])

    def test_timeout_kills_ffmpeg_and_releases_quota(self):
        self.service.timeout = 0.5
        self.slow()
        task = self.wait(self.submit(self.a, self.b).get_json()["id"])
        self.assertEqual((task["status"], task["errorCode"]), ("failed", "PROCESSING_TIMEOUT"))
        self.assertEqual(self.ledger.aborted, {task["id"]})
        self.assertFalse(self.ledger.committed)

    def test_failure_during_publication_marks_failed_and_releases(self):
        def broken_complete(context, task, output):
            raise VideoError("LIBRARY_UNAVAILABLE", "Library unavailable.", 503)
        self.service.hooks = VideoHooks(self.ledger.accept, broken_complete, self.ledger.abort)
        task = self.wait(self.submit(self.a, self.b).get_json()["id"])
        self.assertEqual((task["status"], task["errorCode"]), ("failed", "LIBRARY_UNAVAILABLE"))
        self.assertEqual(self.ledger.aborted, {task["id"]})
        self.assertFalse((self.service.root / task["id"] / "result.mp4").exists())

    def test_other_user_or_project_cannot_access_tasks(self):
        task_id = self.submit(self.a, self.b).get_json()["id"]
        self.wait(task_id)
        for other in (VideoContext("bob", "free", "project-a"), VideoContext("alice", "free", "project-b")):
            self.context = other
            with self.subTest(other=other):
                self.assertEqual(self.client.get(f"/video/concat/tasks/{task_id}").status_code, 404)
                self.assertEqual(self.client.get("/video/concat/tasks").get_json(), [])

    def test_restart_fails_interrupted_task_and_releases_reservation(self):
        directory = self.service.root / "11111111-1111-1111-1111-111111111111"
        directory.mkdir()
        (directory / "input_00").write_bytes(b"partial")
        (directory / "task.json").write_text(json.dumps({
            "id": directory.name, "status": "processing", "progress": 40,
            "outputFormat": "mp4", "_userId": "alice", "_projectId": "project-a", "_profile": "free"}))
        restarted = ConcatService(self.temp.name, VideoHooks(
            self.ledger.accept, self.ledger.complete, self.ledger.abort))
        try:
            task = json.loads((directory / "task.json").read_text())
            self.assertEqual((task["status"], task["errorCode"]), ("failed", "PROCESSING_INTERRUPTED"))
            self.assertIn(directory.name, self.ledger.aborted)
            self.assertFalse((directory / "input_00").exists())
        finally:
            restarted.close()


class IntegrationTests(unittest.TestCase):
    """register_concat usa os mesmos adaptadores do trim, com audiência e pasta próprias."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.environment = patch.dict(os.environ, {"VIDEO_INTERNAL_SECRET": "test-internal-key"})
        self.environment.start()
        from use_cases.concat_integration import register_concat
        self.app = Flask(__name__)
        self.service = register_concat(self.app, self.directory.name)
        self.client = self.app.test_client()

    def tearDown(self):
        self.service.close()
        self.environment.stop()
        self.directory.cleanup()

    def token(self, audience):
        claims = {"user_id": "a" * 24, "project_id": "b" * 24, "profile": "free",
                  "exp": time.time() + 60, "aud": audience}
        encode = lambda data: base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b"=").decode()
        prefix = encode({"alg": "HS256"}) + "." + encode(claims)
        signature = hmac.new(b"test-internal-key", prefix.encode(), hashlib.sha256).digest()
        return prefix + "." + base64.urlsafe_b64encode(signature).rstrip(b"=").decode()

    def test_only_concat_audience_is_accepted(self):
        for audience, status in [("video-trim", 401), ("video-concat", 200)]:
            with self.subTest(audience=audience):
                response = self.client.get("/video/concat/tasks",
                                           headers={"Authorization": "Bearer " + self.token(audience)})
                self.assertEqual(response.status_code, status)

    def test_publication_tells_projects_to_read_the_concat_folder(self):
        calls = []
        def respond(request, **kwargs):
            calls.append(request)
            return io.BytesIO(b'{"ok":true}')
        task = {"id": "c" * 36, "outputFormat": "mp4", "downloadName": "a_joined.mp4",
                "result": {"duration": 5}}
        context = VideoContext("a" * 24, "free", "b" * 24)
        with patch("utils.integration.urlopen", side_effect=respond):
            self.service.hooks.complete(context, task, Path("unused"))
        self.assertEqual(json.loads(calls[0].data)["processor"], "concat")
        self.assertTrue(calls[1].full_url.endswith("/commit"))


if __name__ == "__main__":
    unittest.main()
