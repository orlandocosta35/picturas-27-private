"""UC-VID-002: trimming rules, FFmpeg command and HTTP routes."""
from bisect import bisect_right
import json
import logging
import math
import shutil
import tempfile
import uuid
from pathlib import Path
from flask import Blueprint, jsonify, request, send_file
from werkzeug.exceptions import RequestEntityTooLarge
from werkzeug.utils import secure_filename
from utils.common import (EPSILON, profile_limits, VideoError as TrimError,
                          VideoContext as TrimContext, VideoHooks as TrimHooks,
                          VideoJob as _Job, utc_now as _now, finite_number as _number)
from utils.media import probe_json as _probe_json, probe_video
from utils.tasks import VideoTaskService

LOGGER = logging.getLogger(__name__)

def validate_interval(start, end, duration):
    start, end = _number(start, "O início"), _number(end, "O fim")
    if start < 0 or end > duration + EPSILON or start >= end:
        raise TrimError("INVALID_INTERVAL", "O início tem de ser anterior ao fim e ambos têm de estar dentro do vídeo.")
    end = min(end, duration)
    if end - start < 1 - EPSILON:
        raise TrimError("INTERVAL_TOO_SHORT", "O intervalo tem de ter pelo menos um segundo.")
    return start, end


def keyframe_points(path, info):
    """Fast-mode cut points: every keyframe plus the end of the video."""
    frames = _probe_json(path, ["-select_streams", "v:0", "-skip_frame", "nokey",
                               "-show_frames", "-show_entries", "frame=best_effort_timestamp_time"])
    points = {0.0, info.duration}
    for frame in frames.get("frames", []):
        value = frame.get("best_effort_timestamp_time")
        if value is not None:
            value = float(value) - info.start_time
            if math.isfinite(value) and 0 <= value <= info.duration:
                points.add(value)
    if len(points) <= 2:
        # An all-intra/single-GOP video can have only its first keyframe.
        # EOF is a valid end, but it is not a valid start point.
        LOGGER.debug("Vídeo com um único ponto inicial de corte")
    return sorted(points)


def plan_trim(path, start, end, mode="fast", info=None):
    if mode not in {"precise", "fast"}:
        raise TrimError("INVALID_MODE", "O modo tem de ser precise ou fast.")
    info = info or probe_video(path)
    start, end = validate_interval(start, end, info.duration)
    plan = dict(mode=mode, requestedStartSeconds=start, requestedEndSeconds=end,
                effectiveStartSeconds=start, effectiveEndSeconds=end)
    if abs(start) <= EPSILON and abs(end - info.duration) <= EPSILON:
        return {**plan, "status": "no_changes", "message": "Não há nada a recortar."}
    if mode == "fast":
        points = keyframe_points(path, info)
        effective_start = points[max(0, bisect_right(points, start + EPSILON) - 1)]
        effective_end = points[max(0, bisect_right(points, end + EPSILON) - 1)]
        if effective_end - effective_start < 1 - EPSILON:
            raise TrimError("EFFECTIVE_INTERVAL_TOO_SHORT",
                            "O intervalo efetivo é inferior a um segundo. Altere os tempos ou escolha Preciso.",
                            effectiveStartSeconds=effective_start, effectiveEndSeconds=effective_end)
        plan.update(effectiveStartSeconds=effective_start, effectiveEndSeconds=effective_end)
    changed = any(abs(plan[f"effective{side}Seconds"] - plan[f"requested{side}Seconds"]) > EPSILON
                  for side in ("Start", "End"))
    return {**plan, "status": "confirmation_required" if changed else "ready"}


def build_trim_command(source, destination, info, plan, probe_timeout=60):
    start, end = plan["effectiveStartSeconds"], plan["effectiveEndSeconds"]
    command = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-y",
               "-ss", f"{start:.9f}", "-i", str(source), "-t", f"{end - start:.9f}",
               "-map", "0:v:0", "-map", "0:a?", "-sn", "-dn"]
    if plan["mode"] == "fast":
        # Stream-copy -t uses decoding timestamps. With reordered B-frames it
        # can include pictures beyond the confirmed endpoint. Count packets by
        # presentation time instead; no decoding or FPS assumption is needed.
        packets = _probe_json(source, ["-select_streams", "v:0", "-show_packets",
                                      "-show_entries", "packet=pts_time"], timeout=probe_timeout)
        count = sum(1 for packet in packets.get("packets", [])
                    if packet.get("pts_time") is not None
                    and start - EPSILON <= float(packet["pts_time"]) - info.start_time < end - EPSILON)
        if not count:
            raise TrimError("UNREADABLE_VIDEO", "Não foi possível determinar os fotogramas do corte.", 422)
        command += ["-c", "copy", "-frames:v", str(count)]
    else:
        command += ["-c:v", "libvpx-vp9" if info.container == "webm" else "libx264",
                    "-c:a", "libopus" if info.container == "webm" else "aac",
                    "-fps_mode", "passthrough"]
    if info.container in {"mp4", "mov"}:
        command += ["-movflags", "+faststart"]
    return command + ["-progress", "pipe:1", "-stats_period", "1", str(destination)]


class TrimService(VideoTaskService):
    """Trim-specific submission and result validation."""
    namespace = "trim"

    def submit(self, upload, start, end, mode, context):
        self._context(context)
        if self._closed:
            raise TrimError("SERVICE_CLOSED", "O serviço está a terminar.", 503)
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
                        raise TrimError("INPUT_TOO_LARGE", "O vídeo excede o tamanho permitido para o perfil.", 413)
                    output.write(chunk)
            info = probe_video(source)
            if info.duration > max_duration + EPSILON:
                raise TrimError("INPUT_TOO_LONG", "O vídeo excede a duração permitida para o perfil.")
            plan = plan_trim(source, start, end, mode, info)
            if plan["status"] != "ready":
                return plan, 200
            original = secure_filename(upload.filename or "video")
            start_name = f"{plan['effectiveStartSeconds']:.3f}".replace(".", "s")
            end_name = f"{plan['effectiveEndSeconds']:.3f}".replace(".", "s")
            task = {**plan, "id": task_id, "status": "queued", "progress": 0,
                    "createdAt": _now(), "outputFormat": info.container,
                    "downloadName": f"{Path(original).stem}_corte_{start_name}-{end_name}.{info.container}",
                    "_userId": context.user_id, "_projectId": context.project_id,
                    "_profile": context.profile}
            # Integration must make reservation/concurrency checks atomic by task ID.
            # Journal before reserving, so a crash cannot strand an untracked
            # reservation. abort must be harmless if accept reserved nothing.
            self._save(task)
            reservation_attempted = True
            self.hooks.accept(context, self.public(task))
            accepted = True
            self._save(task)
            job = _Job(task, context)
            with self._lock:
                self._jobs[task_id] = job
            response = self.public(task)
            self._executor.submit(self._run, job, info)
            return response, 202
        except Exception:
            if reservation_attempted:
                task.update(status="failed", finishedAt=_now())
                self._abort(context, task)
                with self._lock:
                    self._jobs.pop(task_id, None)
                self._clean(_Job(task, context))
            raise
        finally:
            if not accepted and not (task and task.get("_abortPending")):
                shutil.rmtree(directory, ignore_errors=True)


    def keyframes(self, upload, context):
        """List the fast-mode cut points so the editor only offers those."""
        self._context(context)
        max_bytes, max_duration = profile_limits(context.profile)
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input"
            size = 0
            with source.open("wb") as output:
                while chunk := upload.stream.read(1024 * 1024):
                    size += len(chunk)
                    if size > max_bytes:
                        raise TrimError("INPUT_TOO_LARGE", "O vídeo excede o tamanho permitido para o perfil.", 413)
                    output.write(chunk)
            info = probe_video(source)
            if info.duration > max_duration + EPSILON:
                raise TrimError("INPUT_TOO_LONG", "O vídeo excede a duração permitida para o perfil.")
            return {"durationSeconds": info.duration, "keyframes": keyframe_points(source, info)}


    def _build_command(self, source, output, info, task, timeout):
        return build_trim_command(source, output, info, task, probe_timeout=timeout)


    def _validate_result(self, info, result, task):
        if (result.width, result.height) != (info.width, info.height):
            raise TrimError("INVALID_RESULT", "A resolução do resultado não corresponde ao original.", 422)
        if result.has_audio != info.has_audio:
            raise TrimError("INVALID_RESULT", "O áudio do resultado não corresponde ao original.", 422)


def create_trim_blueprint(service, context_provider):
    """context_provider() must validate credentials and return a trusted TrimContext.

    Register with app.register_blueprint(...). It intentionally does not import or
    modify the resize application. Never construct the context from request.form.
    """
    blueprint = Blueprint("video_trim", __name__, url_prefix="/video/trim")

    @blueprint.errorhandler(TrimError)
    def handle_error(error):
        return jsonify(error=str(error), code=error.code, **error.details), error.status

    @blueprint.errorhandler(RequestEntityTooLarge)
    def handle_large_upload(error):
        return jsonify(error="O vídeo excede o tamanho permitido para o perfil.", code="INPUT_TOO_LARGE"), 413

    def context():
        return service._context(context_provider())

    @blueprint.post("")
    def submit():
        caller = context()
        # Per-request cap: do not change MAX_CONTENT_LENGTH for the resize app.
        max_bytes, _ = profile_limits(caller.profile)
        request.max_content_length = max_bytes + 131072
        video = request.files.get("video")
        if video is None:
            raise TrimError("MISSING_VIDEO", "É necessário enviar um vídeo.")
        task, status = service.submit(video, request.form.get("startSeconds"),
                                      request.form.get("endSeconds"), request.form.get("mode", "fast"), caller)
        return jsonify(task), status

    @blueprint.post("/keyframes")
    def keyframes():
        caller = context()
        max_bytes, _ = profile_limits(caller.profile)
        request.max_content_length = max_bytes + 131072
        video = request.files.get("video")
        if video is None:
            raise TrimError("MISSING_VIDEO", "É necessário enviar um vídeo.")
        return jsonify(service.keyframes(video, caller))

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
        return jsonify(sorted(tasks, key=lambda t: t.get("createdAt", ""), reverse=True))

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
