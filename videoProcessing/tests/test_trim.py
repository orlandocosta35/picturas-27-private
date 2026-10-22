"""Isolated UC2 tests; requires Flask, FFmpeg and FFprobe, not server.py."""

import hashlib
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
import uuid
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from flask import Flask
from use_cases.trim import TrimContext, TrimError, TrimHooks, TrimService, create_trim_blueprint, probe_video


class Ledger:
    def __init__(self):
        self.reserved = set()
        self.committed = set()
        self.aborted = set()
        self.lock = threading.Lock()

    def accept(self, context, task):
        with self.lock:
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


class TrimTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixtures = tempfile.TemporaryDirectory()
        cls.mp4 = Path(cls.fixtures.name) / "source.mp4"
        cls.webm = Path(cls.fixtures.name) / "silent.webm"
        subprocess.run([
            "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x96:rate=12:duration=6",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=6",
            "-c:v", "libx264", "-threads", "2", "-g", "12", "-keyint_min", "12",
            "-sc_threshold", "0", "-bf", "2", "-c:a", "aac", str(cls.mp4),
        ], check=True)
        subprocess.run([
            "ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x96:rate=12:duration=6",
            "-c:v", "libvpx-vp9", "-threads", "2", "-deadline", "realtime", "-cpu-used", "8",
            "-g", "12", str(cls.webm),
        ], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.fixtures.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.ledger = Ledger()
        self.context = TrimContext("alice", "free", "project-a")
        self.service = TrimService(self.temp.name, TrimHooks(self.ledger.accept, self.ledger.complete, self.ledger.abort))
        self.app = Flask(__name__)
        self.app.config["TESTING"] = True
        self.app.register_blueprint(create_trim_blueprint(self.service, lambda: self.context))
        self.client = self.app.test_client()

    def tearDown(self):
        self.service.close()
        self.temp.cleanup()

    def submit(self, start=1.25, end=3.25, mode="precise", source=None, **extra):
        source = source or self.mp4
        data = {"video": (io.BytesIO(source.read_bytes()), source.name),
                "startSeconds": str(start), "endSeconds": str(end), **extra}
        if mode is not None:
            data["mode"] = mode
        return self.client.post("/video/trim", data=data)

    def wait(self, task_id, final=None):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            task = self.client.get(f"/video/trim/tasks/{task_id}").get_json()
            if task.get("status") in (final or {"completed", "failed", "cancelled"}):
                return task
            time.sleep(0.02)
        self.fail(f"Task did not finish: {task}")

    def test_precise_mp4_audio_preserves_source_resolution_and_rate(self):
        original_hash = hashlib.sha256(self.mp4.read_bytes()).digest()
        response = self.submit()
        self.assertEqual(response.status_code, 202, response.get_json())
        task_id = response.get_json()["id"]
        task = self.wait(task_id)
        self.assertEqual(task["status"], "completed", task)
        self.assertEqual(task["progress"], 100)
        self.assertEqual((task["result"]["width"], task["result"]["height"]), (160, 96))
        self.assertEqual(task["result"]["fps"], 12)
        self.assertTrue(task["result"]["hasAudio"])
        self.assertAlmostEqual(task["result"]["duration"], 2, delta=1 / 12)
        self.assertEqual(hashlib.sha256(self.mp4.read_bytes()).digest(), original_hash)
        self.assertEqual(self.ledger.committed, {task_id})
        self.assertFalse(self.ledger.reserved)
        result = self.client.get(f"/video/trim/tasks/{task_id}/download")
        self.assertEqual(result.status_code, 200)
        self.assertGreater(len(result.data), 0)
        result.close()
        self.assertFalse((self.service.root / task_id / "input").exists())

    def test_precise_webm_without_audio(self):
        response = self.submit(source=self.webm)
        self.assertEqual(response.status_code, 202, response.get_json())
        task = self.wait(response.get_json()["id"])
        self.assertEqual(task["status"], "completed", task)
        self.assertEqual(task["outputFormat"], "webm")
        self.assertFalse(task["result"]["hasAudio"])
        self.assertAlmostEqual(task["result"]["duration"], 2, delta=1 / 12)

    def test_fast_requires_confirmation_without_reserving_or_leaving_files(self):
        response = self.submit(0.5, 3.5, mode=None)
        self.assertEqual(response.status_code, 200, response.get_json())
        plan = response.get_json()
        self.assertEqual(plan["status"], "confirmation_required")
        self.assertAlmostEqual(plan["effectiveStartSeconds"], 0)
        self.assertAlmostEqual(plan["effectiveEndSeconds"], 3)
        self.assertFalse(self.ledger.reserved)
        self.assertEqual(list(self.service.root.iterdir()), [])
        confirmed = self.submit(plan["effectiveStartSeconds"], plan["effectiveEndSeconds"], "fast")
        self.assertEqual(confirmed.status_code, 202, confirmed.get_json())
        task = self.wait(confirmed.get_json()["id"])
        self.assertEqual(task["status"], "completed", task)
        self.assertAlmostEqual(task["result"]["duration"], 3, delta=1 / 12)
        output, _ = self.service.download(task["id"], self.context)
        subprocess.run(["ffmpeg", "-v", "error", "-xerror", "-i", str(output), "-f", "null", "-"], check=True)

    def test_fast_nonzero_start(self):
        response = self.submit(2, 4, "fast")
        self.assertEqual(response.status_code, 202, response.get_json())
        task = self.wait(response.get_json()["id"])
        self.assertEqual(task["status"], "completed", task)
        self.assertAlmostEqual(task["result"]["duration"], 2, delta=1 / 12)
        output, _ = self.service.download(task["id"], self.context)
        def hashes(path, extra):
            raw = subprocess.check_output(["ffmpeg", "-v", "error", *extra,
                "-i", str(path), "-map", "0:v:0", "-an", "-f", "framemd5", "-"]).decode()
            return [line.rsplit(",", 1)[-1].strip() for line in raw.splitlines()
                    if line and not line.startswith("#")]
        self.assertEqual(hashes(output, []), hashes(self.mp4, ["-ss", "2"])[:24])

    def test_invalid_intervals_do_not_create_jobs(self):
        for start, end in [(2, 2), (3, 1), (-1, 3), (0, 7), (1, 1.9), ("nan", 3), (1, "inf")]:
            with self.subTest(start=start, end=end):
                response = self.submit(start, end)
                self.assertEqual(response.status_code, 400, response.get_json())
        self.assertFalse(self.ledger.reserved)
        self.assertEqual(list(self.service.root.iterdir()), [])

    def test_full_video_is_noop(self):
        response = self.submit(0, 6)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["status"], "no_changes")
        self.assertFalse(self.ledger.reserved)
        self.assertEqual(list(self.service.root.iterdir()), [])

    def test_invalid_mode_and_too_short_effective_interval(self):
        response = self.submit(mode="unknown")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["code"], "INVALID_MODE")
        response = self.submit(0.2, 1.2, "fast")
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(response.get_json()["status"], "confirmation_required")
        self.assertAlmostEqual(response.get_json()["effectiveEndSeconds"], 1)
        response = self.submit(0, 1.5, "fast", source=self.mp4)
        self.assertEqual(response.status_code, 200)
        info = probe_video(self.mp4)
        with patch("use_cases.trim._probe_json", return_value={"frames": []}):
            from use_cases.trim import plan_trim
            with self.assertRaises(TrimError) as raised:
                plan_trim(self.mp4, 0, 1.5, "fast", info)
            self.assertEqual(raised.exception.code, "EFFECTIVE_INTERVAL_TOO_SHORT")

    def test_unreadable_input(self):
        response = self.client.post("/video/trim", data={
            "video": (io.BytesIO(b"not a video"), "fake.mp4"),
            "startSeconds": "0", "endSeconds": "2", "mode": "precise",
        })
        self.assertEqual(response.status_code, 422, response.get_json())
        self.assertFalse(self.ledger.reserved)

    def test_other_user_or_project_cannot_access_jobs(self):
        response = self.submit()
        task_id = response.get_json()["id"]
        self.wait(task_id)
        for context in [TrimContext("bob", "free", "project-a"), TrimContext("alice", "free", "other")]:
            self.context = context
            for method, path in [("get", f"/tasks/{task_id}"), ("get", f"/tasks/{task_id}/download"), ("delete", f"/tasks/{task_id}")]:
                response = getattr(self.client, method)("/video/trim" + path)
                self.assertEqual(response.status_code, 404)

    def test_authentication_does_not_trust_form_fields(self):
        self.context = TrimContext("visitor", "anonymous")
        response = self.submit(premium="true", userId="alice")
        self.assertEqual(response.status_code, 403)
        self.context = None
        self.assertEqual(self.submit().status_code, 401)

    def test_timeout_without_progress_kills_worker_and_refunds(self):
        self.service.timeout = 0.2
        with patch("use_cases.trim.build_trim_command", return_value=[sys.executable, "-c", "import time; time.sleep(10)"]):
            response = self.submit()
            task = self.wait(response.get_json()["id"])
            self.assertEqual(task["status"], "failed", task)
            self.assertEqual(task["errorCode"], "PROCESSING_TIMEOUT")
        self.assertFalse(self.ledger.reserved)
        self.assertFalse(self.ledger.committed)

    def test_cancel_running_and_reject_terminal_cancellation(self):
        with patch("use_cases.trim.build_trim_command", return_value=[sys.executable, "-c", "import time; time.sleep(10)"]):
            response = self.submit()
            task_id = response.get_json()["id"]
            self.wait(task_id, {"processing"})
            response = self.client.delete(f"/video/trim/tasks/{task_id}")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json()["status"], "cancelled")
            self.service.close()
            self.assertEqual(self.client.get(f"/video/trim/tasks/{task_id}").get_json()["status"], "cancelled")
        self.assertEqual(self.ledger.aborted, {task_id})
        self.assertFalse(self.ledger.committed)
        self.assertFalse(self.ledger.reserved)
        self.assertFalse((self.service.root / task_id / "input").exists())
        self.assertEqual(self.client.delete(f"/video/trim/tasks/{task_id}").status_code, 409)

    def test_commit_failure_marks_failed_and_cleans_output(self):
        def fail(*args):
            raise TrimError("PUBLICATION_FAILED", "Não foi possível guardar o resultado.", 503)
        self.service.hooks = TrimHooks(self.ledger.accept, fail, self.ledger.abort)
        response = self.submit()
        task = self.wait(response.get_json()["id"])
        self.assertEqual(task["status"], "failed")
        self.assertFalse(self.ledger.reserved)
        self.service.close()
        self.assertEqual([p.name for p in (self.service.root / task["id"]).iterdir()], ["task.json"])

    def test_restart_fails_interrupted_task_and_releases_reservation(self):
        self.service.close()
        task_id = str(uuid.uuid4())
        directory = self.service.root / task_id
        directory.mkdir()
        task = {"id": task_id, "status": "processing", "progress": 40,
                "_userId": "alice", "_profile": "free", "_projectId": "project-a"}
        (directory / "task.json").write_text(json.dumps(task))
        (directory / "input").write_bytes(b"original copy")
        (directory / "result.mp4").write_bytes(b"partial output")
        self.ledger.reserved.add(task_id)
        self.service = TrimService(self.temp.name,
            TrimHooks(self.ledger.accept, self.ledger.complete, self.ledger.abort))
        recovered = self.service.get(task_id, self.context)
        self.assertEqual(recovered["status"], "failed")
        self.assertEqual(recovered["errorCode"], "PROCESSING_INTERRUPTED")
        self.assertFalse(self.ledger.reserved)
        self.assertEqual([p.name for p in directory.iterdir()], ["task.json"])

    def test_quota_rejection_does_not_start_processing(self):
        def reject(*args):
            raise TrimError("QUOTA_EXCEEDED", "Quota esgotada.", 429)
        self.service.hooks = TrimHooks(reject, self.ledger.complete, self.ledger.abort)
        response = self.submit()
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.get_json()["code"], "QUOTA_EXCEEDED")
        self.assertFalse(self.ledger.committed)
        self.assertEqual(list(self.service.root.iterdir()), [])

    def test_task_discovery_is_scoped_to_user_and_project(self):
        response = self.submit()
        task_id = response.get_json()["id"]
        self.wait(task_id)
        visible = self.client.get("/video/trim/tasks").get_json()
        self.assertEqual([t["id"] for t in visible], [task_id])
        self.assertFalse(any(key.startswith("_") for key in visible[0]))
        self.context = TrimContext("alice", "free", "other-project")
        self.assertEqual(self.client.get("/video/trim/tasks").get_json(), [])

    def test_failed_compensation_is_retried_without_restart(self):
        original_abort = self.ledger.abort
        def unavailable(*args):
            raise RuntimeError("quota offline")
        def fail(*args):
            raise TrimError("PUBLICATION_FAILED", "Publication failed", 503)
        self.service.hooks = TrimHooks(self.ledger.accept, fail, unavailable)
        with self.assertLogs("utils.tasks", level="ERROR"):
            response = self.submit()
            task = self.wait(response.get_json()["id"])
            # Wait for the worker's compensation/cleanup, not just failed status.
            self.service._executor.submit(lambda: None).result(timeout=5)
        journal = self.service.root / task["id"] / "task.json"
        self.assertTrue(json.loads(journal.read_text())["_abortPending"])
        self.service.hooks = TrimHooks(self.ledger.accept, fail, original_abort)
        self.service.retry_pending()
        self.assertNotIn("_abortPending", json.loads(journal.read_text()))
        self.assertFalse(self.ledger.reserved)

    def test_configured_size_limit_accepts_boundary_and_rejects_overflow(self):
        size = self.mp4.stat().st_size
        with patch.dict(os.environ, {"VIDEO_MAX_SIZE_FREE": str(size)}):
            response = self.submit()
            self.assertEqual(response.status_code, 202, response.get_json())
            self.assertEqual(self.wait(response.get_json()["id"])["status"], "completed")
        with patch.dict(os.environ, {"VIDEO_MAX_SIZE_FREE": str(size - 1)}):
            response = self.submit()
            self.assertEqual(response.status_code, 413)
            self.assertEqual(response.get_json()["code"], "INPUT_TOO_LARGE")

    def test_configured_duration_limit_accepts_boundary_and_rejects_overflow(self):
        with patch.dict(os.environ, {"VIDEO_MAX_DURATION_FREE": "6"}):
            response = self.submit()
            self.assertEqual(response.status_code, 202, response.get_json())
            self.assertEqual(self.wait(response.get_json()["id"])["status"], "completed")
        with patch.dict(os.environ, {"VIDEO_MAX_DURATION_FREE": "5.9"}):
            response = self.submit()
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.get_json()["code"], "INPUT_TOO_LONG")

    def test_binary_defaults_and_profile_specific_configuration(self):
        from use_cases.trim import profile_limits
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(profile_limits("free"), (200 * 1024 ** 2, 300))
            self.assertEqual(profile_limits("premium"), (2 * 1024 ** 3, 1800))
            with patch.dict(os.environ, {"VIDEO_MAX_SIZE_PREMIUM": "4096", "VIDEO_MAX_DURATION_PREMIUM": "9"}):
                self.assertEqual(profile_limits("premium"), (4096, 9))
                self.assertEqual(profile_limits("free"), (200 * 1024 ** 2, 300))


if __name__ == "__main__":
    unittest.main(verbosity=2)
