import json
import os
import shutil
import subprocess
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, request, send_file

app = Flask(__name__)
TASK_ROOT = Path(os.environ.get("VIDEO_TASK_ROOT", "/data/tasks"))
TASK_ROOT.mkdir(parents=True, exist_ok=True)
MAX_FREE_WIDTH = int(os.environ.get("VIDEO_MAX_WIDTH_FREE", "1920"))
MAX_FREE_HEIGHT = int(os.environ.get("VIDEO_MAX_HEIGHT_FREE", "1080"))
MAX_PREMIUM_WIDTH = int(os.environ.get("VIDEO_MAX_WIDTH_PREMIUM", "3840"))
MAX_PREMIUM_HEIGHT = int(os.environ.get("VIDEO_MAX_HEIGHT_PREMIUM", "2160"))
MAX_FREE_DURATION = float(os.environ.get("VIDEO_MAX_DURATION_FREE", "300"))
MAX_PREMIUM_DURATION = float(os.environ.get("VIDEO_MAX_DURATION_PREMIUM", "1800"))
MAX_FREE_SIZE = int(os.environ.get("VIDEO_MAX_SIZE_FREE", str(200 * 1024 * 1024)))
MAX_PREMIUM_SIZE = int(os.environ.get("VIDEO_MAX_SIZE_PREMIUM", str(2 * 1024 * 1024 * 1024)))
ALLOWED_INPUTS = {"video/mp4", "video/webm", "video/quicktime"}
ALLOWED_OUTPUTS = {"mp4", "webm"}
SUPPORTED_CONTAINERS = {
    "mp4": {"container": "mp4", "video": {"h264"}, "audio": {"aac"}},
    "webm": {"container": "webm", "video": {"vp9"}, "audio": {"opus"}},
}


class VideoValidationError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


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
        [
            "ffprobe",
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            "-count_frames",
            str(path),
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        raise VideoValidationError(
            "CORRUPTED_VIDEO",
            "O vídeo não pôde ser lido. Verifica se o ficheiro está íntegro.",
        )
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise VideoValidationError(
            "INVALID_VIDEO_METADATA",
            "Não foi possível ler os metadados do vídeo.",
        ) from error


def parse_ratio(value):
    if not value or value in {"0/0", "N/A"}:
        return None
    try:
        numerator, denominator = value.split("/", 1)
        denominator = float(denominator)
        if denominator == 0:
            return None
        return float(numerator) / denominator
    except (ValueError, AttributeError):
        return None


def _metadata_number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def inspect_video(path):
    metadata = ffprobe(path)
    streams = metadata.get("streams") or []
    format_data = metadata.get("format") or {}
    video_streams = [stream for stream in streams if stream.get("codec_type") == "video"]
    audio_streams = [stream for stream in streams if stream.get("codec_type") == "audio"]
    subtitle_streams = [stream for stream in streams if stream.get("codec_type") == "subtitle"]
    unsupported_streams = [
        stream for stream in streams
        if stream.get("codec_type") not in {"video", "audio", "subtitle"}
    ]

    if len(video_streams) != 1:
        raise VideoValidationError(
            "INVALID_VIDEO_STREAMS",
            "O vídeo deve conter exatamente uma faixa de vídeo.",
        )
    if len(audio_streams) > 1:
        raise VideoValidationError(
            "MULTIPLE_AUDIO_STREAMS",
            "O vídeo não pode conter mais do que uma faixa de áudio.",
        )
    if subtitle_streams:
        raise VideoValidationError(
            "SUBTITLE_STREAM_NOT_ALLOWED",
            "Vídeos com legendas não são suportados.",
        )
    if unsupported_streams:
        raise VideoValidationError(
            "UNSUPPORTED_STREAM",
            "O vídeo contém uma faixa não suportada.",
        )

    video = video_streams[0]
    duration = _metadata_number(format_data.get("duration") or video.get("duration"))
    size = _metadata_number(format_data.get("size"))
    if size is None:
        size = path.stat().st_size
    width = video.get("width")
    height = video.get("height")
    fps = parse_ratio(video.get("avg_frame_rate")) or parse_ratio(video.get("r_frame_rate"))
    declared_fps = parse_ratio(video.get("r_frame_rate"))
    average_fps = parse_ratio(video.get("avg_frame_rate"))

    if duration is None or duration <= 0:
        raise VideoValidationError(
            "INVALID_DURATION",
            "Não foi possível determinar uma duração válida para o vídeo.",
        )
    if not isinstance(width, int) or not isinstance(height, int) or width <= 0 or height <= 0:
        raise VideoValidationError(
            "INVALID_VIDEO_DIMENSIONS",
            "Não foi possível determinar a resolução do vídeo.",
        )
    if fps is None or fps <= 0:
        raise VideoValidationError(
            "INVALID_FRAME_RATE",
            "Não foi possível determinar uma taxa de fotogramas válida.",
        )
    if declared_fps is None or average_fps is None or abs(declared_fps - average_fps) > 0.01:
        raise VideoValidationError(
            "VARIABLE_FRAME_RATE",
            "Vídeos com FPS variável não são suportados.",
        )

    format_names = set(str(format_data.get("format_name", "")).split(","))
    if "mp4" in format_names:
        container = "mp4"
    elif "webm" in format_names:
        container = "webm"
    else:
        raise VideoValidationError(
            "UNSUPPORTED_CONTAINER",
            "O contentor do vídeo não é suportado. Usa MP4 ou WebM.",
        )

    expected = SUPPORTED_CONTAINERS[container]
    if video.get("codec_name") not in expected["video"]:
        raise VideoValidationError(
            "UNSUPPORTED_VIDEO_CODEC",
            f"O vídeo {container.upper()} deve utilizar o codec "
            f"{', '.join(sorted(expected['video']))}.",
        )
    if audio_streams and audio_streams[0].get("codec_name") not in expected["audio"]:
        raise VideoValidationError(
            "UNSUPPORTED_AUDIO_CODEC",
            f"O áudio {container.upper()} deve utilizar o codec "
            f"{', '.join(sorted(expected['audio']))}.",
        )

    return {
        "duration": duration,
        "size": int(size),
        "container": container,
        "width": width,
        "height": height,
        "fps": fps,
        "videoCodec": video.get("codec_name"),
        "audioCodec": audio_streams[0].get("codec_name") if audio_streams else None,
        "videoStreams": len(video_streams),
        "audioStreams": len(audio_streams),
        "subtitleStreams": len(subtitle_streams),
    }


def run_task(task):
    task_dir = TASK_ROOT / task["id"]
    input_path = task_dir / "input"
    output_path = task_dir / f"result.{task['outputFormat']}"
    task["status"] = "processing"
    task["startedAt"] = now()
    write_task(task)

    try:
        input_metadata = task.get("inputMetadata") or inspect_video(input_path)
        duration = input_metadata["duration"]
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
    max_width, max_height, max_duration, max_size = (
        (MAX_PREMIUM_WIDTH, MAX_PREMIUM_HEIGHT, MAX_PREMIUM_DURATION, MAX_PREMIUM_SIZE)
        if premium
        else (MAX_FREE_WIDTH, MAX_FREE_HEIGHT, MAX_FREE_DURATION, MAX_FREE_SIZE)
    )
    if output_format not in ALLOWED_OUTPUTS or resize_mode not in {"contain", "cover", "stretch"}:
        return jsonify(error="Unsupported output format or resize mode"), 400
    larger_side, smaller_side = max(width, height), min(width, height)
    max_larger, max_smaller = max(max_width, max_height), min(max_width, max_height)
    if width < 64 or height < 64 or width % 2 or height % 2 or larger_side > max_larger or smaller_side > max_smaller:
        return jsonify(error=f"Dimensions must be even, at least 64px, and at most {max_width}x{max_height}"), 400

    temporary_dir = Path(tempfile.mkdtemp(prefix="video-upload-", dir=TASK_ROOT))
    temporary_input = temporary_dir / "input"
    try:
        file.save(temporary_input)
        if temporary_input.stat().st_size > max_size:
            raise VideoValidationError(
                "VIDEO_TOO_LARGE",
                f"O vídeo excede o limite de {max_size // (1024 * 1024)} MiB do perfil.",
            )
        video_metadata = inspect_video(temporary_input)
        if video_metadata["duration"] > max_duration:
            raise VideoValidationError(
                "VIDEO_TOO_LONG",
                f"O vídeo excede o limite de {int(max_duration // 60)} minutos do perfil.",
            )

        task_id = str(uuid.uuid4())
        task_dir = TASK_ROOT / task_id
        task_dir.mkdir(parents=True)
        shutil.move(str(temporary_input), task_dir / "input")
    except (OSError, subprocess.TimeoutExpired):
        return jsonify(
            error={
                "code": "VIDEO_VALIDATION_FAILED",
                "message": "Não foi possível validar o vídeo.",
            }
        ), 422
    except VideoValidationError as error:
        return jsonify(error={"code": error.code, "message": error.message}), 422
    finally:
        shutil.rmtree(temporary_dir, ignore_errors=True)

    task = {
        "id": task_id, "status": "queued", "progress": 0, "width": width,
        "height": height, "resizeMode": resize_mode, "outputFormat": output_format,
        "createdAt": now(), "downloadName": None,
        "userId": user_id, "inputMetadata": video_metadata,
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

# UC2 is registered separately; the existing resize routes stay unchanged.
from use_cases.trim_integration import register_trim
register_trim(app, TASK_ROOT)

from use_cases.audio_integration import register_audio
register_audio(app, TASK_ROOT)
