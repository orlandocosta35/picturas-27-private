import json
import os
import shutil
import ssl
import subprocess
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

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
VIDEO_INTERNAL_SECRET = os.environ.get("VIDEO_INTERNAL_SECRET", "")
VIDEO_USERS_URL = os.environ.get("VIDEO_USERS_URL", "https://users:10001")
VIDEO_PROJECTS_URL = os.environ.get(
    "VIDEO_PROJECTS_URL", "https://projects:9001/internal/video"
)
TASK_RETENTION_SECONDS = int(os.environ.get("VIDEO_TASK_RETENTION_SECONDS", "86400"))
FAILED_TASK_RETENTION_SECONDS = int(
    os.environ.get("VIDEO_FAILED_TASK_RETENTION_SECONDS", "3600")
)
CLEANUP_INTERVAL_SECONDS = int(
    os.environ.get("VIDEO_TASK_CLEANUP_INTERVAL_SECONDS", "300")
)
TASK_LOCKS = {}
TASK_LOCKS_GUARD = threading.Lock()
RUNNING_TASKS = set()
RUNNING_TASKS_GUARD = threading.Lock()
SUPPORTED_CONTAINERS = {
    "mp4": {"container": "mp4", "video": {"h264"}, "audio": {"aac"}},
    "webm": {"container": "webm", "video": {"vp9"}, "audio": {"opus"}},
}


class VideoValidationError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


class VideoProcessingError(Exception):
    def __init__(self, code, message, retryable=False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


def task_error(code, message, retryable=False):
    return {
        "code": code,
        "message": message,
        "retryable": retryable,
    }


def error_from_exception(error):
    if isinstance(error, VideoProcessingError):
        return task_error(error.code, error.message, error.retryable)
    return task_error(
        "PROCESSING_FAILED",
        "O vídeo não pôde ser processado.",
        False,
    )


def update_task(task, **changes):
    task.update(changes)
    write_task(task)


def now():
    return datetime.now(timezone.utc).isoformat()


def task_path(task_id):
    return TASK_ROOT / task_id / "task.json"


def read_task(task_id):
    path = task_path(task_id)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def write_task(task):
    path = task_path(task["id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as stream:
            json.dump(task, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def task_lock(task_id):
    with TASK_LOCKS_GUARD:
        return TASK_LOCKS.setdefault(task_id, threading.RLock())


def set_task_running(task_id, running):
    with RUNNING_TASKS_GUARD:
        if running:
            RUNNING_TASKS.add(task_id)
        else:
            RUNNING_TASKS.discard(task_id)


def task_timestamp(task, field):
    try:
        return datetime.fromisoformat(task[field]).timestamp()
    except (KeyError, TypeError, ValueError):
        return 0


def remove_task_directory(task_id):
    shutil.rmtree(TASK_ROOT / task_id, ignore_errors=True)


def process_is_ffmpeg(pid, task_dir):
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        command = Path(f"/proc/{pid}/cmdline").read_bytes().decode(errors="ignore")
    except OSError:
        return False
    return "ffmpeg" in command and str(task_dir) in command


def release_recovered_task(task):
    try:
        settle_task(task, "release")
        task.pop("recoveryError", None)
        return True
    except Exception as error:
        task["recoveryError"] = str(error)
        return False


def recover_tasks():
    """Mark work interrupted by a service restart and remove stale uploads."""
    now_timestamp = time.time()
    for directory in TASK_ROOT.iterdir():
        if not directory.is_dir():
            continue
        if directory.name.startswith("video-upload-"):
            if now_timestamp - directory.stat().st_mtime >= FAILED_TASK_RETENTION_SECONDS:
                shutil.rmtree(directory, ignore_errors=True)
            continue
        task_file = directory / "task.json"
        if not task_file.exists():
            continue
        task = read_task(directory.name)
        if not task:
            if now_timestamp - task_file.stat().st_mtime >= FAILED_TASK_RETENTION_SECONDS:
                remove_task_directory(directory.name)
            continue
        if task.get("status") == "completed":
            output = directory / f"result.{task.get('outputFormat', '')}"
            if not output.exists():
                try:
                    internal_call(
                        f"{VIDEO_PROJECTS_URL}/{task['userId']}/{task['projectId']}/results/{task['id']}",
                        method="DELETE",
                    )
                except Exception as error:
                    task["recoveryError"] = str(error)
                task.update({
                    "status": "failed",
                    "stage": "failed",
                    "message": "O resultado local da tarefa não está disponível.",
                    "error": task_error(
                        "RESULT_MISSING",
                        "O resultado local da tarefa não está disponível.",
                        True,
                    ),
                    "finishedAt": now(),
                    "recoveryCode": "RESULT_MISSING",
                })
                release_recovered_task(task)
                write_task(task)
            continue
        if task.get("status") not in {"queued", "processing"}:
            continue
        pid = task.get("processPid")
        if process_is_ffmpeg(pid, directory):
            try:
                os.kill(pid, 15)
            except OSError:
                pass
        output = directory / f"result.{task.get('outputFormat', '')}"
        output.unlink(missing_ok=True)
        task.update({
            "status": "failed",
            "stage": "failed",
            "message": "O processamento foi interrompido pelo reinício do serviço.",
            "error": "O processamento foi interrompido pelo reinício do serviço.",
            "finishedAt": now(),
            "recoveryCode": "TASK_INTERRUPTED",
        })
        task["error"] = task_error("TASK_INTERRUPTED", task["error"], True)
        release_recovered_task(task)
        write_task(task)


def cleanup_tasks():
    """Delete terminal task directories after their retention period."""
    current = time.time()
    with RUNNING_TASKS_GUARD:
        running = set(RUNNING_TASKS)
    for directory in TASK_ROOT.iterdir():
        if not directory.is_dir() or directory.name in running:
            continue
        task = read_task(directory.name)
        if not task:
            continue
        if task.get("recoveryError") and task.get("status") == "failed":
            release_recovered_task(task)
            write_task(task)
        if task.get("recoveryError"):
            continue
        status = task.get("status")
        if status in {"completed", "cancelled"}:
            retention = TASK_RETENTION_SECONDS
        elif status == "failed":
            retention = FAILED_TASK_RETENTION_SECONDS
        else:
            continue
        timestamp = task_timestamp(task, "finishedAt") or directory.stat().st_mtime
        if current - timestamp >= retention:
            remove_task_directory(directory.name)


def maintenance_loop():
    while True:
        try:
            cleanup_tasks()
        except (OSError, ValueError):
            app.logger.exception("Video task cleanup failed")
        time.sleep(max(10, CLEANUP_INTERVAL_SECONDS))


def internal_call(url, data=None, method="POST"):
    if not VIDEO_INTERNAL_SECRET:
        raise RuntimeError("VIDEO_INTERNAL_SECRET is not configured")
    body = json.dumps(data or {}).encode()
    req = Request(
        url,
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {VIDEO_INTERNAL_SECRET}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urlopen(req, context=ssl._create_unverified_context(), timeout=15) as response:
            return json.load(response)
    except HTTPError as error:
        try:
            details = json.loads(error.read(65536))
        except (ValueError, OSError):
            details = {}
        raise RuntimeError(details.get("error", "Internal service rejected the request")) from None
    except (URLError, TimeoutError, OSError) as error:
        raise RuntimeError("Internal service unavailable") from error


def reserve_task(task):
    profile = internal_call(
        f"{VIDEO_USERS_URL}/internal/video-quota/{task['userId']}/profile", method="GET"
    )["type"]
    if profile not in {"free", "premium"}:
        raise RuntimeError("Este perfil não pode processar vídeo.")
    task["profile"] = profile
    internal_call(
        f"{VIDEO_USERS_URL}/internal/video-quota/{task['userId']}/{task['id']}/reserve",
        {"profile": profile},
    )


def settle_task(task, action):
    try:
        internal_call(
            f"{VIDEO_USERS_URL}/internal/video-quota/{task['userId']}/{task['id']}/{action}",
            {"profile": task.get("profile")},
        )
    except RuntimeError as error:
        raise VideoProcessingError(
            "QUOTA_UNAVAILABLE",
            "Não foi possível atualizar a quota desta operação.",
            True,
        ) from error


def publish_task(task):
    try:
        internal_call(
            f"{VIDEO_PROJECTS_URL}/{task['userId']}/{task['projectId']}/results/{task['id']}",
            {
                "format": task["outputFormat"],
                "name": task["downloadName"],
                "metadata": task.get("result", {}),
                # Resize tasks live in the root of the tasks folder, not in tasks/trim.
                "processor": "resize",
            },
        )
    except RuntimeError as error:
        raise VideoProcessingError(
            "LIBRARY_UNAVAILABLE",
            "O resultado foi processado, mas não foi possível guardá-lo na biblioteca.",
            True,
        ) from error


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
    lock = task_lock(task["id"])
    set_task_running(task["id"], True)
    try:
        with lock:
            if task.get("status") == "cancelled":
                return
            update_task(
                task,
                status="processing",
                progress=1,
                stage="encoding",
                message="A converter o vídeo...",
                startedAt=now(),
                error=None,
            )
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
        update_task(task, progress=2, stage="encoding", message="A iniciar a conversão...")
        with lock:
            if (read_task(task["id"]) or task).get("status") == "cancelled":
                return
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        with lock:
            current = read_task(task["id"]) or task
            if current.get("status") == "cancelled":
                process.terminate()
                return
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
                task["progress"] = min(98, max(2, round((elapsed / duration) * 100))) if duration else 2
                task["stage"] = "encoding"
                task["message"] = "A converter o vídeo..."
                write_task(task)
        return_code = process.wait()
        with lock:
            current = read_task(task["id"]) or task
            if current.get("status") == "cancelled":
                if output_path.exists():
                    output_path.unlink()
                return
        if return_code != 0:
            raise VideoProcessingError(
                "FFMPEG_FAILED",
                "O vídeo não pôde ser convertido para o formato selecionado.",
            )
        with lock:
            task.update({
                "status": "processing", "progress": 99, "stage": "saving",
                "message": "A guardar o resultado na biblioteca.",
                "downloadName": f"resized-{task['id']}.{task['outputFormat']}",
                "result": {"width": width, "height": height, "duration": duration},
            })
            write_task(task)
            publish_task(task)
            settle_task(task, "commit")
            update_task(
                task,
                status="completed",
                progress=100,
                stage="completed",
                message="Processamento concluído.",
                error=None,
                finishedAt=now(),
            )
    except Exception as error:
        with lock:
            current = read_task(task["id"]) or task
            if current.get("status") == "cancelled":
                return
            task.update({
                "status": "failed",
                "progress": task.get("progress", 0),
                "stage": "failed",
                "message": "O processamento falhou.",
                "error": error_from_exception(error),
                "finishedAt": now(),
            })
            try:
                internal_call(
                    f"{VIDEO_PROJECTS_URL}/{task['userId']}/{task['projectId']}/results/{task['id']}",
                    method="DELETE",
                )
            except Exception as cleanup_error:
                task["recoveryError"] = str(cleanup_error)
            try:
                settle_task(task, "release")
            except Exception as release_error:
                task["recoveryError"] = str(release_error)
            write_task(task)
        if output_path.exists():
            output_path.unlink()
    finally:
        set_task_running(task["id"], False)


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
        profile = request.form["profile"]
        user_id = request.form["userId"]
        project_id = request.form["projectId"]
    except (KeyError, ValueError):
        return jsonify(error="Invalid resize parameters"), 400
    max_width, max_height, max_duration, max_size = (
        (MAX_PREMIUM_WIDTH, MAX_PREMIUM_HEIGHT, MAX_PREMIUM_DURATION, MAX_PREMIUM_SIZE)
        if profile == "premium"
        else (MAX_FREE_WIDTH, MAX_FREE_HEIGHT, MAX_FREE_DURATION, MAX_FREE_SIZE)
    )
    if profile not in {"free", "premium"}:
        return jsonify(error="Invalid user profile"), 403
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
        "stage": "queued", "message": "Tarefa criada.",
        "error": None,
        "userId": user_id, "projectId": project_id, "profile": profile,
        "inputMetadata": video_metadata,
    }
    try:
        reserve_task(task)
    except Exception as error:
        shutil.rmtree(task_dir, ignore_errors=True)
        return jsonify(error=task_error(
            "QUOTA_RESERVATION_FAILED",
            "Não foi possível reservar a quota para esta operação.",
            True,
        )), 429
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


@app.delete("/video/tasks/<task_id>")
def cancel_task(task_id):
    task = read_task(task_id)
    if not task or request.args.get("userId") != task.get("userId"):
        return jsonify(error="Task not found"), 404
    lock = task_lock(task_id)
    with lock:
        task = read_task(task_id)
        if task.get("status") in {"completed", "failed"}:
            return jsonify(task)
        pid = task.get("processPid")
        if pid:
            try:
                os.kill(pid, 15)
            except ProcessLookupError:
                pass
        task.update({
            "status": "cancelled",
            "stage": "cancelled",
            "message": "O processamento foi cancelado.",
            "finishedAt": now(),
            "error": None,
        })
        write_task(task)
        try:
            internal_call(
                f"{VIDEO_PROJECTS_URL}/{task['userId']}/{task['projectId']}/results/{task_id}",
                method="DELETE",
            )
            settle_task(task, "release")
        except Exception as error:
            return jsonify(error=str(error)), 503
        write_task(task)
    output = TASK_ROOT / task_id / f"result.{task['outputFormat']}"
    if output.exists():
        output.unlink()
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

# Register the modular UC2, UC3 and UC5 operations alongside resize.
from use_cases.trim_integration import register_trim
from use_cases.audio_integration import register_audio
from use_cases.concat_integration import register_concat

register_trim(app, TASK_ROOT)
register_audio(app, TASK_ROOT)
register_concat(app, TASK_ROOT)
recover_tasks()
threading.Thread(target=maintenance_loop, name="video-task-cleanup", daemon=True).start()
