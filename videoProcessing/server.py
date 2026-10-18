import json
import os
import shutil
import subprocess
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, request, send_file

app = Flask(__name__)
TASK_ROOT = Path(os.environ.get("VIDEO_TASK_ROOT", "/data/tasks"))
TASK_ROOT.mkdir(parents=True, exist_ok=True)
MAX_FREE_WIDTH, MAX_FREE_HEIGHT = 1920, 1080
MAX_PREMIUM_WIDTH, MAX_PREMIUM_HEIGHT = 3840, 2160
ALLOWED_INPUTS = {"video/mp4", "video/webm", "video/quicktime"}
ALLOWED_OUTPUTS = {"mp4", "webm"}


def now():
    return datetime.now(timezone.utc).isoformat()


def task_path(task_id):
    return TASK_ROOT / task_id / "task.json"


def read_task(task_id):
    path = task_path(task_id)
    if not path.exists():
        return None
    return json.loads(path.read_text())


def write_task(task):
    path = task_path(task["id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(task))


def ffprobe(path):
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        check=True, capture_output=True, text=True,
    )
    return float(result.stdout.strip())


def run_task(task):
    task_dir = TASK_ROOT / task["id"]
    input_path = task_dir / "input"
    output_path = task_dir / f"result.{task['outputFormat']}"
    task["status"] = "processing"
    task["startedAt"] = now()
    write_task(task)

    try:
        duration = ffprobe(input_path)
        width, height = task["width"], task["height"]
        mode = task["resizeMode"]
        if mode == "stretch":
            video_filter = f"scale={width}:{height}"
        elif mode == "cover":
            video_filter = (
                f"scale={width}:{height}:force_original_aspect_ratio=increase,"
                f"crop={width}:{height}"
            )
        else:
            video_filter = (
                f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
                f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2"
            )

        codec_args = (
            ["-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart"]
            if task["outputFormat"] == "mp4"
            else ["-c:v", "libvpx-vp9", "-c:a", "libopus"]
        )
        command = [
            "ffmpeg", "-y", "-i", str(input_path), "-vf", video_filter,
            "-progress", "pipe:1", "-nostats", *codec_args, str(output_path),
        ]
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        task["processPid"] = process.pid
        write_task(task)
        for line in process.stdout:
            if line.startswith("out_time_ms="):
                raw_elapsed = line.split("=", 1)[1].strip()
                if raw_elapsed == "N/A":
                    continue
                try:
                    elapsed = int(raw_elapsed) / 1_000_000
                except ValueError:
                    continue
                task["progress"] = min(99, round((elapsed / duration) * 100)) if duration else 0
                write_task(task)
        return_code = process.wait()
        if return_code != 0:
            raise RuntimeError(process.stderr.read()[-1000:] or "FFmpeg failed")
        task.update({
            "status": "completed", "progress": 100, "finishedAt": now(),
            "downloadName": f"resized-{task['id']}.{task['outputFormat']}",
        })
        write_task(task)
    except Exception as error:
        task.update({"status": "failed", "error": str(error), "finishedAt": now()})
        write_task(task)
        if output_path.exists():
            output_path.unlink()


@app.post("/video/resize")
def create_resize_task():
    file = request.files.get("video")
    if not file or file.mimetype not in ALLOWED_INPUTS:
        return jsonify(error="Input must be an MP4, WebM or MOV video"), 400
    try:
        width = int(request.form["width"])
        height = int(request.form["height"])
        output_format = request.form["outputFormat"]
        resize_mode = request.form["resizeMode"]
        premium = request.form.get("premium", "false") == "true"
        user_id = request.form["userId"]
    except (KeyError, ValueError):
        return jsonify(error="Invalid resize parameters"), 400
    max_width, max_height = (MAX_PREMIUM_WIDTH, MAX_PREMIUM_HEIGHT) if premium else (MAX_FREE_WIDTH, MAX_FREE_HEIGHT)
    if output_format not in ALLOWED_OUTPUTS or resize_mode not in {"contain", "cover", "stretch"}:
        return jsonify(error="Unsupported output format or resize mode"), 400
    larger_side, smaller_side = max(width, height), min(width, height)
    max_larger, max_smaller = max(max_width, max_height), min(max_width, max_height)
    if width < 64 or height < 64 or width % 2 or height % 2 or larger_side > max_larger or smaller_side > max_smaller:
        return jsonify(error=f"Dimensions must be even, at least 64px, and at most {max_width}x{max_height}"), 400

    task_id = str(uuid.uuid4())
    task_dir = TASK_ROOT / task_id
    task_dir.mkdir(parents=True)
    file.save(task_dir / "input")
    task = {
        "id": task_id, "status": "queued", "progress": 0, "width": width,
        "height": height, "resizeMode": resize_mode, "outputFormat": output_format,
        "createdAt": now(), "downloadName": None,
        "userId": user_id,
    }
    write_task(task)
    threading.Thread(target=run_task, args=(task,), daemon=True).start()
    return jsonify(task), 202


@app.get("/video/tasks/<task_id>")
def get_task(task_id):
    task = read_task(task_id)
    if not task:
        return jsonify(error="Task not found"), 404
    if request.args.get("userId") != task.get("userId"):
        return jsonify(error="Task not found"), 404
    return jsonify(task)


@app.get("/video/tasks/<task_id>/download")
def download_task(task_id):
    task = read_task(task_id)
    if not task or task.get("status") != "completed" or request.args.get("userId") != task.get("userId"):
        return jsonify(error="Result is not available"), 404
    output = TASK_ROOT / task_id / f"result.{task['outputFormat']}"
    if not output.exists():
        return jsonify(error="Result file is missing"), 404
    return send_file(output, as_attachment=True, download_name=task["downloadName"])
