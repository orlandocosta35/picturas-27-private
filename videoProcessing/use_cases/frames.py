"""UC-VID-004 frame extraction and ZIP generation.

The HTTP/task integration is intentionally left to the next phase.  The
functions here are safe to call from that layer and keep all temporary files
outside the source video's directory.
"""
from collections.abc import Callable
import shutil
from pathlib import Path
import subprocess
import tempfile
from typing import Any
import zipfile
import json
import uuid

from flask import Blueprint, jsonify, request, send_file
from werkzeug.exceptions import RequestEntityTooLarge
from werkzeug.utils import secure_filename
from utils.common import VideoError, VideoInfo
from utils.common import EPSILON, VideoContext, profile_limits, utc_now
from utils.media import probe_video
from utils.tasks import VideoTaskService, VideoJob
from use_cases.frames_domain import FramePlan, frame_instants, frame_name
from use_cases.frames_domain import plan_frames


def image_extension(image_format: str) -> str:
    if image_format == "jpeg":
        return "jpg"
    if image_format == "png":
        return "png"
    raise VideoError("INVALID_IMAGE_FORMAT", "Image format must be JPEG or PNG.")


def jpeg_quality_to_ffmpeg(quality: int | None) -> int | None:
    """Map the public JPEG quality scale (1..100) to FFmpeg's q:v scale."""
    if quality is None:
        return None
    return max(1, min(31, round((100 - quality) * 30 / 99) + 1))


def build_single_frame_command(
    source: Path,
    destination: Path,
    timestamp: float,
    image_format: str,
    quality: int | None,
) -> list[str]:
    command = [
        "ffmpeg",
        "-v",
        "error",
        "-ss",
        f"{timestamp:.6f}",
        "-i",
        str(source),
        "-frames:v",
        "1",
        "-y",
    ]
    if image_format == "jpeg":
        command.extend(["-q:v", str(jpeg_quality_to_ffmpeg(quality))])
    elif image_format != "png":
        raise VideoError("INVALID_IMAGE_FORMAT", "Image format must be JPEG or PNG.")
    return command + [str(destination)]


def _run_frame_command(command: list[str], timeout: float) -> None:
    try:
        subprocess.run(command, check=True, capture_output=True, timeout=timeout)
    except FileNotFoundError:
        raise VideoError("FFMPEG_UNAVAILABLE", "FFmpeg is unavailable.", 503) from None
    except subprocess.TimeoutExpired:
        raise VideoError("PROCESSING_TIMEOUT", "Frame extraction timed out.") from None
    except subprocess.CalledProcessError as error:
        details = error.stderr.decode(errors="replace").strip()[-1000:]
        raise VideoError("FRAME_EXTRACTION_FAILED", "Could not extract a video frame.",
                         stderr=details) from None


def extract_frames(
    source: Path,
    output_directory: Path,
    plan: FramePlan,
    info: VideoInfo,
    *,
    timeout_per_frame: float = 60,
    cancel_check: Callable[[], bool] | None = None,
    progress_callback: Callable[[int, int], None] | None = None,
) -> list[Path]:
    """Extract and name frames in chronological order.

    FFmpeg seeks to each requested instant and writes one frame.  The first
    readable frame at or after that instant is therefore selected, matching
    RN7 without creating duplicate output names.
    """
    source = Path(source)
    output_directory = Path(output_directory)
    output_directory.mkdir(parents=True, exist_ok=True)
    instants = frame_instants(plan, info.fps)
    extension = image_extension(plan.image_format)
    frames: list[Path] = []
    temporary = Path(tempfile.mkdtemp(prefix="frames-", dir=output_directory))
    try:
        total = len(instants)
        for index, timestamp in enumerate(instants):
            if cancel_check and cancel_check():
                raise VideoError("CANCELLED", "Frame extraction was cancelled.")
            destination = temporary / frame_name(index, timestamp, extension)
            _run_frame_command(
                build_single_frame_command(
                    source, destination, timestamp, plan.image_format, plan.quality
                ),
                timeout_per_frame,
            )
            if not destination.is_file() or destination.stat().st_size == 0:
                raise VideoError("FRAME_EXTRACTION_FAILED", "FFmpeg produced an empty frame.")
            final_path = output_directory / destination.name
            shutil.move(destination, final_path)
            frames.append(final_path)
            if progress_callback:
                progress_callback(len(frames), total)
        if not frames:
            raise VideoError("NO_FRAMES", "The selected interval produced no frames.")
        return frames
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def create_frames_zip(
    frames: list[Path],
    destination: Path,
    plan: FramePlan,
    *,
    cancel_check: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    """Create the final ZIP and enforce the real frame and size limits."""
    if len(frames) > plan.limits.max_frames:
        raise VideoError(
            "FRAME_LIMIT_EXCEEDED",
            "The real number of frames exceeds the profile limit.",
            frameCount=len(frames),
            maxFrames=plan.limits.max_frames,
        )
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for frame in frames:
                if cancel_check and cancel_check():
                    raise VideoError("CANCELLED", "Frame extraction was cancelled.")
                archive.write(frame, arcname=frame.name)
                if destination.stat().st_size > plan.limits.max_zip_bytes:
                    raise VideoError(
                        "ZIP_SIZE_LIMIT_EXCEEDED",
                        "The real ZIP size exceeds the profile limit.",
                        zipBytes=destination.stat().st_size,
                        maxZipBytes=plan.limits.max_zip_bytes,
                    )
        zip_bytes = destination.stat().st_size
        if zip_bytes > plan.limits.max_zip_bytes:
            raise VideoError(
                "ZIP_SIZE_LIMIT_EXCEEDED",
                "The real ZIP size exceeds the profile limit.",
                zipBytes=zip_bytes,
                maxZipBytes=plan.limits.max_zip_bytes,
            )
        return {
            "frameCount": len(frames),
            "zipBytes": zip_bytes,
            "preview": [frame.name for frame in frames[:10]],
        }
    except Exception:
        destination.unlink(missing_ok=True)
        raise


def process_frames(
    source: Path,
    destination: Path,
    plan: FramePlan,
    info: VideoInfo,
    *,
    timeout_per_frame: float = 60,
    cancel_check: Callable[[], bool] | None = None,
    progress_callback: Callable[[int, int], None] | None = None,
) -> dict[str, Any]:
    """Extract frames, create a ZIP and return result metadata."""
    working = Path(tempfile.mkdtemp(prefix="frames-job-"))
    try:
        frames = extract_frames(
            source,
            working,
            plan,
            info,
            timeout_per_frame=timeout_per_frame,
            cancel_check=cancel_check,
            progress_callback=progress_callback,
        )
        result = create_frames_zip(
            frames, destination, plan, cancel_check=cancel_check
        )
        return {
            **result,
            "processor": "frames",
            "operation": "frames",
            "startSeconds": plan.start_seconds,
            "endSeconds": plan.end_seconds,
            "durationSeconds": plan.duration_seconds,
            "mode": plan.mode,
            "imageFormat": plan.image_format,
            "quality": plan.quality,
        }
    finally:
        shutil.rmtree(working, ignore_errors=True)


class FramesService(VideoTaskService):
    """Persistent UC4 tasks stored below ``<task_root>/frames``."""

    namespace = "frames"

    def submit(self, upload, params: dict[str, Any], context: VideoContext):
        self._context(context)
        if self._closed:
            raise VideoError("SERVICE_CLOSED", "The service is shutting down.", 503)
        max_bytes, max_duration = profile_limits(context.profile)
        task_id = str(uuid.uuid4())
        directory = self.root / task_id
        directory.mkdir()
        source = directory / "input"
        accepted = False
        reservation_attempted = False
        task = None
        try:
            size = 0
            with source.open("wb") as output:
                while chunk := upload.stream.read(1024 * 1024):
                    size += len(chunk)
                    if size > max_bytes:
                        raise VideoError(
                            "INPUT_TOO_LARGE",
                            "The video exceeds the file size limit for this profile.",
                            413,
                        )
                    output.write(chunk)
            info = probe_video(source)
            if info.duration > max_duration + EPSILON:
                raise VideoError(
                    "INPUT_TOO_LONG",
                    "The video exceeds the duration limit for this profile.",
                )
            plan = plan_frames(params, info, context.profile)
            original = secure_filename(upload.filename or "video")
            extension = "zip"
            task = {
                "id": task_id,
                "status": "queued",
                "progress": 0,
                "createdAt": utc_now(),
                "outputFormat": extension,
                "downloadName": f"{Path(original).stem}_frames.zip",
                "plan": {
                    "startSeconds": plan.start_seconds,
                    "endSeconds": plan.end_seconds,
                    "durationSeconds": plan.duration_seconds,
                    "mode": plan.mode,
                    "fps": plan.fps,
                    "everyN": plan.every_n,
                    "imageFormat": plan.image_format,
                    "quality": plan.quality,
                    "estimatedFrames": plan.estimated_frames,
                    "estimatedZipBytes": plan.estimated_zip_bytes,
                },
                "estimatedFrames": plan.estimated_frames,
                "estimatedZipBytes": plan.estimated_zip_bytes,
                "maxFrames": plan.limits.max_frames,
                "maxZipBytes": plan.limits.max_zip_bytes,
                "_userId": context.user_id,
                "_projectId": context.project_id,
                "_profile": context.profile,
            }
            self._save(task)
            reservation_attempted = True
            self.hooks.accept(context, self.public(task))
            accepted = True
            self._save(task)
            job = VideoJob(task, context)
            with self._lock:
                self._jobs[task_id] = job
            response = self.public(task)
            self._executor.submit(self._run_frames, job, info)
            return response, 202
        except Exception:
            if reservation_attempted and task:
                task.update(status="failed", finishedAt=utc_now())
                self._abort(context, task)
                with self._lock:
                    self._jobs.pop(task_id, None)
                self._clean(VideoJob(task, context))
            raise
        finally:
            if not accepted and not (task and task.get("_abortPending")):
                shutil.rmtree(directory, ignore_errors=True)

    def _run_frames(self, job: VideoJob, info: VideoInfo):
        task = job.task
        directory = self.root / task["id"]
        try:
            with job.lock:
                if job.cancelled.is_set():
                    return
                task.update(status="processing", startedAt=utc_now())
                self._save(task)
            plan_data = task["plan"]
            plan = plan_frames(
                {
                    **plan_data,
                    "format": plan_data["imageFormat"],
                },
                info,
                task["_profile"],
                first_frame_bytes=0,
            )

            def progress(extracted: int, total: int):
                with job.lock:
                    if not job.cancelled.is_set():
                        task["progress"] = min(99, int(extracted / max(1, total) * 100))
                        self._save(task)

            result = process_frames(
                directory / "input",
                directory / "result.zip",
                plan,
                info,
                timeout_per_frame=min(60, max(0.01, self.timeout)),
                cancel_check=job.cancelled.is_set,
                progress_callback=progress,
            )
            with job.lock:
                if job.cancelled.is_set():
                    return
                task["result"] = result
                self.hooks.complete(job.context, self.public(task), directory / "result.zip")
                self._clean(job, keep_result=True)
                task.update(status="completed", progress=100, finishedAt=utc_now())
                self._save(task)
        except Exception as error:
            with job.lock:
                if not job.cancelled.is_set():
                    task.update(
                        status="failed",
                        finishedAt=utc_now(),
                        error=str(error),
                        errorCode=getattr(error, "code", "PROCESSING_FAILED"),
                    )
                    self._save(task)
                    self._abort(job.context, task)
        finally:
            with job.lock:
                self._clean(job, keep_result=task["status"] == "completed")
            with self._lock:
                self._jobs.pop(task["id"], None)


def create_frames_blueprint(service, context_provider):
    """Create the authenticated internal UC4 HTTP blueprint."""
    blueprint = Blueprint("video_frames", __name__, url_prefix="/video/frames")

    @blueprint.errorhandler(VideoError)
    def handle_error(error):
        return jsonify(error=str(error), code=error.code, **error.details), error.status

    @blueprint.errorhandler(RequestEntityTooLarge)
    def handle_large_upload(error):
        return jsonify(
            error=str(error) or "The video exceeds the file size limit for this profile.",
            code="INPUT_TOO_LARGE",
        ), 413

    def context():
        return service._context(context_provider())

    @blueprint.post("")
    def submit():
        caller = context()
        max_bytes, _ = profile_limits(caller.profile)
        request.max_content_length = max_bytes + 131072
        video = request.files.get("video")
        if video is None:
            raise VideoError("MISSING_VIDEO", "A video file is required.")
        params = request.form.to_dict()
        return_value, status = service.submit(video, params, caller)
        return jsonify(return_value), status

    @blueprint.get("/tasks")
    def list_tasks():
        caller = context()
        tasks = []
        for path in service.root.glob("*/task.json"):
            try:
                task = json.loads(path.read_text())
                if task.get("_userId") == caller.user_id and task.get("_projectId") == caller.project_id:
                    tasks.append(service.public(task))
            except (ValueError, OSError):
                continue
        return jsonify(sorted(tasks, key=lambda item: item.get("createdAt", ""), reverse=True))

    @blueprint.get("/tasks/<task_id>")
    def get_task(task_id):
        return jsonify(service.get(task_id, context()))

    @blueprint.get("/tasks/<task_id>/download")
    def download(task_id):
        output, name = service.download(task_id, context())
        return send_file(output, as_attachment=True, download_name=name)

    @blueprint.delete("/tasks/<task_id>")
    def cancel(task_id):
        return jsonify(service.cancel(task_id, context()))

    return blueprint
