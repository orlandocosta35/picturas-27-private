"""Teste manual do UC5 contra o serviço real, fazendo o papel do gateway.

Corre dentro do container video_processing (tem o VIDEO_INTERNAL_SECRET e o
serviço em localhost:12000). Usa a quota e a biblioteca verdadeiras: o
utilizador e o projeto de vídeo têm de existir, e o perfil tem de ser o atual.

    docker compose cp a.mp4 video_processing:/tmp/a.mp4
    docker compose cp b.mp4 video_processing:/tmp/b.mp4
    docker compose cp videoProcessing/tests/manual_concat.py video_processing:/tmp/
    docker compose exec video_processing python /tmp/manual_concat.py \
        <userId> <projectId> free /tmp/a.mp4 /tmp/b.mp4

Opções: --cancel cancela logo após aceitar o pedido.
"""

import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import sys
import time
import uuid
from urllib.error import HTTPError
from urllib.request import Request, urlopen

BASE = "http://localhost:12000/video/concat"


def token(user_id, project_id, profile):
    secret = os.environ["VIDEO_INTERNAL_SECRET"].encode()
    encode = lambda data: base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b"=").decode()
    claims = {"user_id": user_id, "project_id": project_id, "profile": profile,
              "exp": time.time() + 600, "aud": "video-concat"}
    prefix = encode({"alg": "HS256", "typ": "JWT"}) + "." + encode(claims)
    signature = hmac.new(secret, prefix.encode(), hashlib.sha256).digest()
    return prefix + "." + base64.urlsafe_b64encode(signature).rstrip(b"=").decode()


def call(method, url, auth, body=None, content_type=None):
    headers = {"Authorization": f"Bearer {auth}"}
    if content_type:
        headers["Content-Type"] = content_type
    try:
        with urlopen(Request(url, data=body, method=method, headers=headers), timeout=600) as response:
            data = response.read()
            return response.status, data
    except HTTPError as error:
        return error.code, error.read()


def multipart(paths):
    boundary = uuid.uuid4().hex
    parts = []
    for path in paths:
        parts += [f"--{boundary}".encode(),
                  f'Content-Disposition: form-data; name="videos"; filename="{path.name}"'.encode(),
                  b"Content-Type: video/mp4", b"", path.read_bytes()]
    parts += [f"--{boundary}--".encode(), b""]
    return b"\r\n".join(parts), f"multipart/form-data; boundary={boundary}"


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) < 4:
        sys.exit(__doc__)
    user_id, project_id, profile, *files = args
    auth = token(user_id, project_id, profile)
    body, content_type = multipart([Path(f) for f in files])

    status, data = call("POST", BASE, auth, body, content_type)
    print("POST", status, data.decode())
    if status != 202:
        return
    task_id = json.loads(data)["id"]

    if "--cancel" in sys.argv:
        status, data = call("DELETE", f"{BASE}/tasks/{task_id}", auth)
        print("DELETE", status, data.decode())

    while True:
        status, data = call("GET", f"{BASE}/tasks/{task_id}", auth)
        task = json.loads(data)
        print(f"  {task.get('status')} {task.get('progress')}%")
        if task.get("status") in {"completed", "failed", "cancelled"}:
            print(json.dumps(task, indent=2, ensure_ascii=False))
            break
        time.sleep(1)

    if task["status"] == "completed":
        status, data = call("GET", f"{BASE}/tasks/{task_id}/download", auth)
        output = Path("/tmp") / task["downloadName"]
        output.write_bytes(data)
        print("Result em", output)


if __name__ == "__main__":
    main()
