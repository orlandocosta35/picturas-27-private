"""UC1 extraction regression tests with real FFmpeg and isolated task storage."""
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from flask import Flask
from use_cases import resize
from use_cases.resize_integration import register_resize


class ResizeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixtures = tempfile.TemporaryDirectory()
        cls.source = Path(cls.fixtures.name) / 'source.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                        'testsrc2=size=160x96:rate=12:duration=1', '-f', 'lavfi', '-i',
                        'sine=frequency=440:duration=1', '-c:v', 'libx264', '-threads', '2',
                        '-c:a', 'aac', '-shortest', str(cls.source)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.fixtures.cleanup()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root_patch = patch.object(resize, 'TASK_ROOT', Path(self.directory.name))
        self.root_patch.start()
        self.app = Flask(__name__)
        self.app.config['TESTING'] = True
        self.app.register_blueprint(resize.blueprint)
        self.client = self.app.test_client()

    def tearDown(self):
        self.root_patch.stop()
        self.directory.cleanup()

    def submit(self, mode='contain'):
        return self.client.post('/video/resize', data={
            'video': (io.BytesIO(self.source.read_bytes()), 'source.mp4'),
            'width': '128', 'height': '128', 'outputFormat': 'mp4',
            'resizeMode': mode, 'profile': 'free', 'userId': 'alice', 'projectId': 'project',
        })

    def test_real_resize_modes_publish_commit_and_download(self):
        for mode in ('contain', 'cover', 'stretch'):
            with self.subTest(mode=mode), patch.object(resize, 'reserve_task'), \
                    patch.object(resize.threading, 'Thread'), \
                    patch.object(resize, 'publish_task') as publish, \
                    patch.object(resize, 'settle_task') as settle:
                response = self.submit(mode)
                self.assertEqual(response.status_code, 202)
                task = response.get_json()
                resize.run_task(task)
                saved = resize.read_task(task['id'])
                self.assertEqual(saved['status'], 'completed', saved.get('error'))
                self.assertEqual(saved['progress'], 100)
                publish.assert_called_once()
                settle.assert_called_once_with(task, 'commit')
                output = resize.inspect_video(resize.TASK_ROOT / task['id'] / 'result.mp4')
                self.assertEqual((output['width'], output['height']), (128, 128))
                self.assertAlmostEqual(output['duration'], 1, delta=0.15)
                self.assertEqual(self.client.get(f"/video/tasks/{task['id']}?userId=alice").status_code, 200)
                download = self.client.get(f"/video/tasks/{task['id']}/download?userId=alice")
                self.assertEqual(download.status_code, 200)
                download.close()
                self.assertEqual(self.client.get(f"/video/tasks/{task['id']}?userId=bob").status_code, 404)

    def test_quota_failure_leaves_no_upload(self):
        with patch.object(resize, 'reserve_task', side_effect=RuntimeError('unavailable')):
            response = self.submit()
        self.assertEqual(response.status_code, 429)
        self.assertEqual(list(resize.TASK_ROOT.iterdir()), [])

    def test_missing_video_is_rejected(self):
        self.assertEqual(self.client.post('/video/resize').status_code, 400)

    def test_registration_starts_recovery_and_maintenance(self):
        app = Flask('registration')
        with patch.object(resize, 'recover_tasks') as recover, \
                patch('use_cases.resize_integration.threading.Thread') as thread:
            register_resize(app, self.directory.name)
        recover.assert_called_once()
        thread.return_value.start.assert_called_once()
        routes = {str(rule) for rule in app.url_map.iter_rules()}
        self.assertIn('/video/resize', routes)
        self.assertIn('/video/tasks/<task_id>/download', routes)
        self.assertIs(app.extensions['video_resize_maintenance'], thread.return_value)

    def test_recovery_preserves_other_use_case_directories(self):
        for name in ('trim', 'audio', 'concat'):
            directory = resize.TASK_ROOT / name
            directory.mkdir()
            (directory / 'sentinel').write_text('preserve')
        resize.recover_tasks()
        resize.cleanup_tasks()
        for name in ('trim', 'audio', 'concat'):
            self.assertEqual((resize.TASK_ROOT / name / 'sentinel').read_text(), 'preserve')
