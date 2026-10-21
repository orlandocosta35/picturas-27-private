"""Trusted gateway context and idempotent adapters for users/projects."""
import atexit
import base64
import hashlib
import hmac
import json
import os
import ssl
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from flask import request
from trim import TrimContext, TrimError, TrimHooks, TrimService, create_trim_blueprint


def register_trim(app, task_root):
    secret = os.environ.get('VIDEO_INTERNAL_SECRET', '')
    if not secret:
        raise RuntimeError('VIDEO_INTERNAL_SECRET is required for trim integration')
    users = os.environ.get('VIDEO_USERS_URL', 'https://users:10001')
    projects = os.environ.get('VIDEO_PROJECTS_URL', 'https://projects:9001/internal/video')
    # Existing internal services use self-signed TLS certificates.
    tls = ssl._create_unverified_context()

    def call(url, data=None, method='POST'):
        body = json.dumps(data or {}).encode()
        req = Request(url, data=body, method=method, headers={
            'Authorization': f'Bearer {secret}', 'Content-Type': 'application/json'})
        try:
            with urlopen(req, context=tls, timeout=15) as response:
                return json.load(response)
        except HTTPError as error:
            try:
                details = json.loads(error.read(65536))
            except (ValueError, OSError):
                details = {}
            raise TrimError(details.get('code', 'INTEGRATION_FAILED'),
                            details.get('error', 'Não foi possível guardar o resultado ou atualizar a quota.'),
                            error.code) from None
        except (URLError, TimeoutError, OSError):
            raise TrimError('INTEGRATION_UNAVAILABLE', 'Serviço de projetos ou quota indisponível.', 503) from None

    def quota(ctx, task, action):
        return call(f'{users}/internal/video-quota/{ctx.user_id}/{task["id"]}/{action}',
                    {'profile': ctx.profile})

    def result_url(ctx, task):
        return f'{projects}/{ctx.user_id}/{ctx.project_id}/results/{task["id"]}'

    def accept(ctx, task):
        quota(ctx, task, 'reserve')

    def complete(ctx, task, output):
        call(result_url(ctx, task), {'format': task['outputFormat'],
             'name': task['downloadName'], 'metadata': task['result']})
        quota(ctx, task, 'commit')

    def abort(ctx, task):
        # Retry both compensations on recovery if either service is unavailable.
        errors = []
        try:
            call(result_url(ctx, task), method='DELETE')
        except TrimError as error:
            if error.status != 404:
                errors.append(error)
        try:
            quota(ctx, task, 'release')
        except TrimError as error:
            errors.append(error)
        if errors:
            raise errors[0]

    def context():
        try:
            token = request.headers.get('Authorization', '').removeprefix('Bearer ')
            header, payload, signature = token.split('.')
            decode = lambda part: base64.urlsafe_b64decode(part + '=' * (-len(part) % 4))
            metadata, claims = json.loads(decode(header)), json.loads(decode(payload))
            expected = hmac.new(secret.encode(), f'{header}.{payload}'.encode(), hashlib.sha256).digest()
            if (metadata.get('alg') != 'HS256' or not hmac.compare_digest(expected, decode(signature))
                    or claims['exp'] <= time.time() or claims.get('aud') != 'video-trim'):
                raise ValueError
            import re
            if not all(re.fullmatch(r'[a-fA-F0-9]{24}', claims[key]) for key in ('user_id', 'project_id')):
                raise ValueError
            return TrimContext(claims['user_id'], claims['profile'], claims['project_id'])
        except (ValueError, KeyError, TypeError, AttributeError):
            raise TrimError('AUTHENTICATION_REQUIRED', 'Credenciais de vídeo inválidas ou expiradas.', 401) from None

    service = TrimService(task_root, TrimHooks(accept, complete, abort))
    app.register_blueprint(create_trim_blueprint(service, context))
    app.extensions['video_trim'] = service
    atexit.register(service.close)
    return service
