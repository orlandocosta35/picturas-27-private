"""Register UC5 using the common video-service integration.

Besides the shared quota/library hooks, UC5 exposes the user's library with the
metadata of each video (REQ-VID-CON-007), read straight from projects' /source.
"""
from concurrent.futures import ThreadPoolExecutor
import json
import os
import ssl
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from use_cases.concat import ConcatError, ConcatService, create_concat_blueprint, describe, inspect_source
from utils.common import VideoError
from utils.integration import register_video_service


def register_concat(app, task_root):
    projects = os.environ.get('VIDEO_PROJECTS_URL', 'https://projects:9001/internal/video')
    auth = {'Authorization': f'Bearer {os.environ.get("VIDEO_INTERNAL_SECRET", "")}'}
    # Existing internal services use self-signed TLS certificates.
    tls = ssl._create_unverified_context()

    def library(ctx):
        # projects lists only this user's video projects and /source refuses others.
        try:
            with urlopen(Request(f'{projects}/{ctx.user_id}/library', headers=auth),
                         context=tls, timeout=15) as response:
                items = json.load(response)
        except (HTTPError, URLError, TimeoutError, OSError, ValueError):
            raise VideoError('INTEGRATION_UNAVAILABLE', 'Serviço de projetos indisponível.', 503) from None

        def with_metadata(item):
            try:
                info = inspect_source(f'{projects}/{ctx.user_id}/{item["projectId"]}/source', auth)
                return {**item, **describe(info)}
            except ConcatError as error:
                return {**item, 'error': error.message, 'code': error.code}
            except VideoError as error:
                return {**item, 'error': str(error), 'code': error.code}

        with ThreadPoolExecutor(max_workers=4) as pool:
            return list(pool.map(with_metadata, items))

    return register_video_service(
        app, task_root, ConcatService,
        lambda service, context: create_concat_blueprint(service, context, library),
        'concat')
