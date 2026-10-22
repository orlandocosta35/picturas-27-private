"""UC3 tests with real FFmpeg: preserved video packets and measurable sound."""
import array
import hashlib
import io
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from flask import Flask
from use_cases.audio import AudioService, AUDIO_MAX_BYTES, create_audio_blueprint
from utils.common import VideoContext, VideoError, VideoHooks
import test_trim as trim_tests


class AudioIndependenceTests(unittest.TestCase):
    def test_audio_imports_without_trim(self):
        subprocess.run([sys.executable, '-c',
            "import sys; sys.modules['use_cases.trim'] = None; "
            "sys.modules['use_cases.trim_integration'] = None; "
            "from use_cases.audio import AudioService; "
            "from use_cases.audio_integration import register_audio; "
            "from utils.tasks import VideoTaskService; "
            "assert issubclass(AudioService, VideoTaskService)"],
            cwd=Path(__file__).resolve().parents[1], check=True)


class AudioTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        trim_tests.TrimTests.setUpClass.__func__(cls)
        cls.wav = Path(cls.fixtures.name) / 'music.wav'
        cls.long_wav = Path(cls.fixtures.name) / 'long.wav'
        for target, duration in [(cls.wav, 2), (cls.long_wav, 7)]:
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                f'sine=frequency=880:sample_rate=48000:duration={duration}', str(target)], check=True)
        cls.offset = Path(cls.fixtures.name) / 'offset.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(cls.mp4), '-itsoffset', '0.5', '-i', str(cls.mp4),
            '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-t', '6', str(cls.offset)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.fixtures.cleanup()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.ledger = trim_tests.Ledger()
        self.service = AudioService(self.directory.name,
            VideoHooks(self.ledger.accept, self.ledger.complete, self.ledger.abort))
        self.context = VideoContext('alice', 'free', 'project')
        self.app = Flask(__name__)
        self.app.config['TESTING'] = True
        self.app.register_blueprint(create_audio_blueprint(self.service, lambda: self.context))
        self.client = self.app.test_client()

    def tearDown(self):
        self.service.close()
        self.directory.cleanup()

    def submit(self, operation='volume', auxiliary=None, source=None, inspect=False, **params):
        source = source or self.mp4
        data = {'video': (io.BytesIO(source.read_bytes()), source.name),
                'operation': operation, **{k: str(v) for k, v in params.items()}}
        if auxiliary:
            data['audio'] = (io.BytesIO(auxiliary.read_bytes()), auxiliary.name)
        response = self.client.post('/video/audio' + ('/inspect' if inspect else ''), data=data)
        response.request.environ['wsgi.input'].close()
        return response

    def complete(self, response):
        self.assertEqual(response.status_code, 202, response.get_json())
        task_id = response.get_json()['id']
        until = time.monotonic() + 15
        while time.monotonic() < until:
            task = self.service.get(task_id, self.context)
            if task['status'] in {'completed', 'failed', 'cancelled'}:
                self.assertEqual(task['status'], 'completed', task)
                self.service._executor.submit(lambda: None).result(timeout=5)
                return self.service.download(task_id, self.context)[0], task
            time.sleep(0.02)
        self.fail('Task timeout')

    def packets(self, path):
        data = subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=data_hash', '-of', 'json', str(path)])
        return [p['data_hash'] for p in json.loads(data)['packets']]

    def rms(self, path, start=0, duration=0.3):
        data = subprocess.check_output(['ffmpeg', '-v', 'error', '-ss', str(start), '-i', str(path),
            '-t', str(duration), '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'])
        samples = array.array('f'); samples.frombytes(data)
        return math.sqrt(sum(s*s for s in samples) / max(1, len(samples)))

    def test_volume_preserves_image_and_reduces_sound(self):
        original = hashlib.sha256(self.mp4.read_bytes()).digest()
        output, task = self.complete(self.submit(volume=50))
        self.assertEqual(self.packets(output), self.packets(self.mp4))
        self.assertAlmostEqual(self.rms(output, 1) / self.rms(self.mp4, 1), 0.5, delta=0.08)
        self.assertAlmostEqual(task['result']['duration'], 6, delta=0.1)
        self.assertEqual(hashlib.sha256(self.mp4.read_bytes()).digest(), original)
        self.assertEqual(len(self.ledger.committed), 1)

    def test_remove_requires_confirmation_then_removes_track(self):
        response = self.submit('remove')
        self.assertEqual(response.get_json()['status'], 'confirmation_required')
        self.assertFalse(self.ledger.reserved)
        self.assertEqual(list(self.service.root.iterdir()), [])
        output, task = self.complete(self.submit('remove', confirmRemove='true'))
        self.assertFalse(task['result']['hasAudio'])
        self.assertEqual(self.packets(output), self.packets(self.mp4))

    def test_zero_and_amplification_require_confirmation(self):
        for volume, code in [(0, 'ZERO_VOLUME'), (101, 'AMPLIFICATION')]:
            response = self.submit(volume=volume)
            self.assertEqual(response.get_json()['warnings'][0]['code'], code)
            self.assertFalse(self.ledger.reserved)
        output, _ = self.complete(self.submit(volume=0, confirmZero='true'))
        self.assertLess(self.rms(output, 1), 1e-6)

    def test_invalid_parameters_and_fades(self):
        for params in [dict(volume=301), dict(volume=-1), dict(volume='nan'), dict(fadeIn=6),
                       dict(fadeIn=4, fadeOut=4)]:
            response = self.submit(**params)
            self.assertEqual(response.status_code, 400, response.get_json())
        self.assertFalse(self.ledger.reserved)
        self.assertEqual(list(self.service.root.iterdir()), [])

    def test_silent_video_only_accepts_replacement(self):
        for operation in ['volume', 'remove']:
            self.assertEqual(self.submit(operation, source=self.webm).status_code, 400)
        response = self.submit('overlay', source=self.webm, auxiliary=self.wav, overlayMode='mix')
        self.assertEqual(response.status_code, 400)
        output, task = self.complete(self.submit('overlay', source=self.webm, auxiliary=self.wav,
            overlayMode='replace', shortPolicy='silence'))
        self.assertTrue(task['result']['hasAudio'])
        self.assertEqual(self.packets(output), self.packets(self.webm))
        self.assertGreater(self.rms(output, 0.5), 0.01)
        self.assertLess(self.rms(output, 4), 0.0001)

    def test_short_audio_requires_explicit_policy(self):
        response = self.submit('overlay', auxiliary=self.wav, overlayMode='replace')
        self.assertEqual(response.get_json()['status'], 'choice_required')
        self.assertEqual(list(self.service.root.iterdir()), [])
        self.assertFalse(self.ledger.reserved)

    def test_repeated_audio_fills_remaining_video_and_fades_once(self):
        output, task = self.complete(self.submit('overlay', auxiliary=self.wav, overlayMode='replace',
            startSeconds=1, shortPolicy='repeat', fadeIn=0.5, fadeOut=0.5))
        self.assertEqual(self.packets(output), self.packets(self.mp4))
        self.assertLess(self.rms(output, 0.1), 0.0001)
        self.assertGreater(self.rms(output, 4.5), 0.02)
        self.assertLess(self.rms(output, 5.85, 0.1), self.rms(output, 4.5) * 0.5)
        self.assertAlmostEqual(task['result']['duration'], 6, delta=0.1)

    def test_mix_keeps_original_after_auxiliary_ends_without_normalization(self):
        output, _ = self.complete(self.submit('overlay', auxiliary=self.wav, overlayMode='mix', shortPolicy='silence'))
        self.assertGreater(self.rms(output, 1), self.rms(self.mp4, 1) * 1.25)
        self.assertAlmostEqual(self.rms(output, 4) / self.rms(self.mp4, 4), 1, delta=0.08)

    def test_long_overlay_requires_confirmation_and_does_not_extend_video(self):
        response = self.submit('overlay', auxiliary=self.wav, overlayMode='replace', startSeconds=5)
        self.assertEqual(response.get_json()['warnings'][0]['code'], 'TRIM_AUDIO')
        output, task = self.complete(self.submit('overlay', auxiliary=self.wav, overlayMode='replace',
                                               startSeconds=5, confirmTrim='true'))
        self.assertAlmostEqual(task['result']['duration'], 6, delta=0.1)
        self.assertLess(self.rms(output, 2), 0.0001)
        self.assertGreater(self.rms(output, 5.3), 0.01)

    def test_auxiliary_duration_over_110_percent_is_rejected(self):
        response = self.submit('overlay', auxiliary=self.long_wav, overlayMode='replace')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()['code'], 'AUDIO_TOO_LONG')
        self.assertEqual(list(self.service.root.iterdir()), [])

    def test_inspection_validates_audio_and_never_reserves_quota(self):
        response = self.submit(auxiliary=self.wav, inspect=True)
        self.assertEqual(response.status_code, 200)
        self.assertAlmostEqual(response.get_json()['audio']['duration'], 2, delta=0.01)
        self.assertTrue(response.get_json()['video']['has_audio'])
        self.assertFalse(self.ledger.reserved)
        self.assertEqual(list(self.service.root.iterdir()), [])

    def test_audio_size_limit_and_unreadable_file(self):
        fake = Path(self.directory.name) / 'fake.wav'
        fake.write_bytes(b'not audio')
        response = self.submit('overlay', auxiliary=fake, overlayMode='replace')
        self.assertEqual(response.status_code, 422)
        with patch('use_cases.audio.AUDIO_MAX_BYTES', self.wav.stat().st_size - 1):
            response = self.submit('overlay', auxiliary=self.wav, overlayMode='replace')
            self.assertEqual(response.status_code, 413)
            self.assertEqual(response.get_json()['code'], 'AUDIO_TOO_LARGE')
        self.assertEqual(list(self.service.root.iterdir()), [])

    def test_offset_original_audio_remains_synchronized(self):
        output, _ = self.complete(self.submit(source=self.offset, volume=50))
        self.assertLess(self.rms(output, 0.05, 0.2), 0.0001)
        self.assertLess(self.rms(output, 0.3, 0.1), 0.0001)
        self.assertGreater(self.rms(output, 0.6, 0.1), 0.01)
        self.assertAlmostEqual(self.rms(output, 1) / self.rms(self.offset, 1), 0.5, delta=0.08)

    def test_all_documented_audio_formats_are_inspected(self):
        for extension in ['mp3', 'aac', 'ogg']:
            with self.subTest(extension=extension):
                path = Path(self.directory.name) / f'music.{extension}'
                subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(self.wav), str(path)], check=True)
                response = self.submit(auxiliary=path, inspect=True)
                self.assertEqual(response.status_code, 200, response.get_json())
                self.assertEqual(response.get_json()['audio']['format'], extension)
        self.assertFalse(self.ledger.reserved)
        self.assertEqual(list(self.service.root.iterdir()), [])

    def test_fades_are_checked_after_overlay_cutting(self):
        response = self.submit('overlay', auxiliary=self.wav, overlayMode='replace', startSeconds=5,
                               fadeIn=0.6, fadeOut=0.6, confirmTrim='true')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()['code'], 'INVALID_FADES')
        self.assertFalse(self.ledger.reserved)

    def test_cancel_removes_auxiliary_and_refunds(self):
        with patch('use_cases.audio.build_audio_command', return_value=[sys.executable, '-c', 'import time; time.sleep(10)']):
            response = self.submit('overlay', auxiliary=self.wav, overlayMode='replace', shortPolicy='repeat')
            task_id = response.get_json()['id']
            response = self.client.delete(f'/video/audio/tasks/{task_id}')
            self.assertEqual(response.status_code, 200)
            self.service.close()
        self.assertFalse(self.ledger.reserved)
        self.assertFalse(self.ledger.committed)
        self.assertEqual([p.name for p in (self.service.root / task_id).iterdir()], ['task.json'])

    def test_publishing_failure_cleans_auxiliary_and_result(self):
        def fail(*args):
            raise RuntimeError('publication failed')
        self.service.hooks = VideoHooks(self.ledger.accept, fail, self.ledger.abort)
        response = self.submit('overlay', auxiliary=self.wav, overlayMode='replace', shortPolicy='repeat')
        task_id = response.get_json()['id']
        self.service._executor.submit(lambda: None).result(timeout=15)
        self.assertEqual(self.service.get(task_id, self.context)['status'], 'failed')
        self.assertFalse(self.ledger.reserved)
        self.assertEqual([p.name for p in (self.service.root / task_id).iterdir()], ['task.json'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
