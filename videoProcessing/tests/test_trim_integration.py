"""Gateway trust boundary and service adapters; no external services required."""
import base64
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from flask import Flask
from use_cases.trim import TrimContext, TrimError
from use_cases.trim_integration import register_trim


class IntegrationAdapterTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.environment = patch.dict(os.environ, {'VIDEO_INTERNAL_SECRET': 'test-internal-key'})
        self.environment.start()
        self.app = Flask(__name__)
        self.service = register_trim(self.app, self.directory.name)
        self.client = self.app.test_client()
        self.context = TrimContext('a' * 24, 'free', 'b' * 24)
        self.task = {'id': 'c' * 36, 'outputFormat': 'mp4', 'downloadName': 'cut.mp4', 'result': {'duration': 2}}

    def tearDown(self):
        self.service.close()
        self.environment.stop()
        self.directory.cleanup()

    def token(self, header=None, **overrides):
        claims = {'user_id': self.context.user_id, 'project_id': self.context.project_id,
                  'profile': 'free', 'exp': time.time() + 60, 'aud': 'video-trim', **overrides}
        encode = lambda data: base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b'=').decode()
        prefix = encode(header if header is not None else {'alg': 'HS256'}) + '.' + encode(claims)
        signature = hmac.new(b'test-internal-key', prefix.encode(), hashlib.sha256).digest()
        return prefix + '.' + base64.urlsafe_b64encode(signature).rstrip(b'=').decode()

    def test_only_valid_gateway_tokens_can_list_tasks(self):
        tokens = ['', 'bad.token.value', self.token(exp=0), self.token(aud='other'),
                  self.token(header={'alg': 'none'}), self.token(header=[]), self.token() + 'x']
        for token in tokens:
            with self.subTest(token=token[:10]):
                response = self.client.get('/video/trim/tasks', headers={'Authorization': 'Bearer ' + token})
                self.assertEqual(response.status_code, 401)
        response = self.client.get('/video/trim/tasks', headers={'Authorization': 'Bearer ' + self.token()})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), [])

    def test_anonymous_profile_is_rejected_even_in_a_signed_context(self):
        response = self.client.get('/video/trim/tasks', headers={
            'Authorization': 'Bearer ' + self.token(profile='anonymous')})
        self.assertEqual(response.status_code, 403)

    def test_publish_precedes_quota_commit(self):
        calls = []
        def respond(request, **kwargs):
            calls.append(request)
            return io.BytesIO(b'{"ok":true}')
        with patch('utils.integration.urlopen', side_effect=respond):
            self.service.hooks.complete(self.context, self.task, Path('unused'))
        self.assertIn('/results/', calls[0].full_url)
        self.assertTrue(calls[1].full_url.endswith('/commit'))
        self.assertEqual(json.loads(calls[0].data)['name'], 'cut.mp4')
        self.assertTrue(all(c.get_header('Authorization') == 'Bearer test-internal-key' for c in calls))

    def test_abort_attempts_quota_release_when_library_is_unavailable(self):
        urls = []
        def respond(request, **kwargs):
            urls.append(request.full_url)
            if '/results/' in request.full_url:
                raise HTTPError(request.full_url, 503, 'unavailable', {}, io.BytesIO(b'{}'))
            return io.BytesIO(b'{"ok":true}')
        with patch('utils.integration.urlopen', side_effect=respond):
            with self.assertRaises(TrimError):
                self.service.hooks.abort(self.context, self.task)
        self.assertTrue(urls[-1].endswith('/release'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
