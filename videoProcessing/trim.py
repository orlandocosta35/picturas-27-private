"""UC-VID-002: isolated trimming module; registering it in server.py is separate.

Use create_trim_blueprint(service, context_provider) with a trusted authentication
adapter. The three hooks integrate shared quota and the project library:
  accept(context, task): atomically check eligibility/concurrency and reserve quota;
  complete(context, task, output): publish the result and commit quota;
  abort(context, task): idempotently release quota/undo incomplete publication.
Hooks must be idempotent by task ID. This module never trusts a form user/premium.
One TrimService/executor per task directory is supported, not multiple replicas.
"""

from bisect import bisect_right
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from fractions import Fraction
import json
import logging
import math
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import tempfile
import threading
import time
import uuid

from flask import Blueprint, jsonify, request, send_file
from werkzeug.exceptions import RequestEntityTooLarge
from werkzeug.utils import secure_filename


LOGGER = logging.getLogger(__name__)
ACTIVE = {"queued", "processing"}
EPSILON = 1e-6


class TrimError(Exception):
    def __init__(self, code, message, status=400, **details):
        super().__init__(message)
        self.code, self.status, self.details = code, status, details


@dataclass(frozen=True)
class TrimContext:
    user_id: str
    profile: str
    project_id: str = ""


@dataclass(frozen=True)
class TrimHooks:
    accept: object
    complete: object
    abort: object


@dataclass(frozen=True)
class VideoInfo:
    duration: float
    width: int
    height: int
    fps: Fraction
    container: str
    has_audio: bool
    start_time: float = 0


@dataclass
class _Job:
    task: dict
    context: TrimContext
    lock: object = field(default_factory=threading.RLock)
    cancelled: object = field(default_factory=threading.Event)


def _now():
    return datetime.now(timezone.utc).isoformat()


def _number(value, name):
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        raise TrimError("INVALID_INTERVAL", f"{name} tem de ser um número finito.") from None
    if not math.isfinite(result):
        raise TrimError("INVALID_INTERVAL", f"{name} tem de ser um número finito.")
    return result


def _probe_json(path, args, timeout=60):
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", *args, "-of", "json", str(path)],
            check=True, capture_output=True, text=True, timeout=max(0.01, timeout),
        )
        return json.loads(result.stdout)
    except FileNotFoundError:
        raise TrimError("FFPROBE_UNAVAILABLE", "FFprobe não está disponível.", 503) from None
    except subprocess.TimeoutExpired:
        raise TrimError("PROBE_TIMEOUT", "A análise do vídeo excedeu o tempo permitido.", 422) from None
    except (subprocess.CalledProcessError, ValueError):
        raise TrimError("UNREADABLE_VIDEO", "Não foi possível ler este vídeo.", 422) from None


def probe_video(path, timeout=60):
    """Inspect actual content; an upload's MIME type/extension is not evidence."""
    data = _probe_json(path, ["-show_format", "-show_streams"], timeout)
    streams = data.get("streams", [])
    videos = [s for s in streams if s.get("codec_type") == "video"
              and not s.get("disposition", {}).get("attached_pic")]
    fmt = data.get("format", {})
    if not videos:
        raise TrimError("UNREADABLE_VIDEO", "Não foi possível ler este vídeo.", 422)
    video = videos[0]
    formats = set(fmt.get("format_name", "").split(","))
    if "mp4" in formats or "mov" in formats:
        container = "mov" if fmt.get("tags", {}).get("major_brand", "").strip() == "qt" else "mp4"
    elif "webm" in formats and video.get("codec_name") in {"vp8", "vp9", "av1"}:
        # ffprobe reports both matroska and webm; the EBML DocType disambiguates.
        container = "webm"
        with open(path, "rb") as source:
            if b"webm" not in source.read(4096):
                raise TrimError("UNSUPPORTED_FORMAT", "O formato deste vídeo não é suportado.", 415)
    else:
        raise TrimError("UNSUPPORTED_FORMAT", "O formato deste vídeo não é suportado.", 415)
    try:
        duration = _number(video.get("duration", fmt.get("duration")), "A duração")
        fps = Fraction(video.get("avg_frame_rate", "0/1"))
        if fps <= 0:
            fps = Fraction(video.get("r_frame_rate", "0/1"))
        width, height = int(video["width"]), int(video["height"])
        start_time = float(video.get("start_time", fmt.get("start_time", 0)))
        if duration <= 0 or fps <= 0 or width <= 0 or height <= 0 or not math.isfinite(start_time):
            raise ValueError
    except (KeyError, ValueError, ZeroDivisionError, TrimError):
        raise TrimError("UNREADABLE_VIDEO", "Não foi possível ler este vídeo.", 422) from None
    return VideoInfo(duration, width, height, fps, container,
                     any(s.get("codec_type") == "audio" for s in streams), start_time)


def validate_interval(start, end, duration):
    start, end = _number(start, "O início"), _number(end, "O fim")
    if start < 0 or end > duration + EPSILON or start >= end:
        raise TrimError("INVALID_INTERVAL", "O início tem de ser anterior ao fim e ambos têm de estar dentro do vídeo.")
    end = min(end, duration)
    if end - start < 1 - EPSILON:
        raise TrimError("INTERVAL_TOO_SHORT", "O intervalo tem de ter pelo menos um segundo.")
    return start, end


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
        points = sorted(points)
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


class TrimService:
    """Persistent trim jobs with a local queue; no dependency on server.py.

    All hooks are mandatory, so exposing the Blueprint without shared quota/library
    integration cannot silently bypass those rules. Completion is serialized with
    cancellation; complete must roll back its own side effects if it raises.
    """

    # Subclasses (e.g. concat) override this to keep their task files apart.
    namespace = "trim"

    def __init__(self, task_root, hooks, timeout_seconds=1800):
        if not isinstance(hooks, TrimHooks) or not all(callable(x) for x in (hooks.accept, hooks.complete, hooks.abort)):
            raise ValueError("TrimHooks com accept, complete e abort são obrigatórios")
        # A private namespace prevents touching the resize service's task files.
        self.root = Path(task_root) / self.namespace
        self.root.mkdir(parents=True, exist_ok=True)
        self.hooks = hooks
        self.timeout = timeout_seconds
        self._jobs = {}
        self._lock = threading.RLock()
        self._closed = False
        self._recover()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="video-trim")
        self._retry_stop = threading.Event()
        self._retry_thread = threading.Thread(target=self._retry_loop, name="trim-compensation", daemon=True)
        self._retry_thread.start()

    def retry_pending(self):
        """Retry durable compensations without requiring another service restart."""
        for path in self.root.glob("*/task.json"):
            with self._lock:
                if path.parent.name in self._jobs:
                    continue
                try:
                    task = json.loads(path.read_text())
                    if task.get("_abortPending") and task.get("status") not in ACTIVE:
                        context = TrimContext(task["_userId"], task["_profile"], task["_projectId"])
                        self._abort(context, task)
                except (ValueError, KeyError, OSError):
                    LOGGER.exception("Falha ao repetir compensação de %s", path.parent.name)

    def _retry_loop(self):
        while not self._retry_stop.wait(30):
            self.retry_pending()

    def _save(self, task):
        directory = self.root / task["id"]
        directory.mkdir(parents=True, exist_ok=True)
        temporary = directory / f".{uuid.uuid4().hex}.json"
        try:
            temporary.write_text(json.dumps(task, allow_nan=False))
            os.replace(temporary, directory / "task.json")
        finally:
            temporary.unlink(missing_ok=True)

    def _abort(self, context, task):
        try:
            self.hooks.abort(context, self.public(task))
            task.pop("_abortPending", None)
        except Exception:
            task["_abortPending"] = True
            LOGGER.exception("Não foi possível libertar a quota de %s; repetir automaticamente", task["id"])
        self._save(task)

    def _recover(self):
        """Single-executor recovery; interrupted work is failed, never rerun."""
        for directory in self.root.iterdir():
            if not directory.is_dir():
                continue
            try:
                if str(uuid.UUID(directory.name)) != directory.name:
                    continue
                path = directory / "task.json"
                if not path.exists():
                    shutil.rmtree(directory)
                    continue
                task = json.loads(path.read_text())
                context = TrimContext(task["_userId"], task["_profile"], task["_projectId"])
                if task["status"] in ACTIVE or task.get("_abortPending"):
                    if task["status"] in ACTIVE:
                        task.update(status="failed", finishedAt=_now(), errorCode="PROCESSING_INTERRUPTED",
                                    error="O processamento foi interrompido. Tente novamente.")
                    self._abort(context, task)
                self._clean(_Job(task, context), keep_result=task["status"] == "completed")
            except (ValueError, KeyError, OSError):
                LOGGER.exception("Não foi possível recuperar a tarefa %s", directory.name)

    @staticmethod
    def _context(context):
        if not isinstance(context, TrimContext) or not context.user_id:
            raise TrimError("AUTHENTICATION_REQUIRED", "É necessário iniciar sessão.", 401)
        if context.profile not in {"free", "premium"}:
            raise TrimError("PROFILE_NOT_ALLOWED", "O perfil Anónimo não pode processar vídeo.", 403)
        return context

    @staticmethod
    def public(task):
        return {k: v for k, v in task.items() if not k.startswith("_")}

    def _load(self, task_id, context):
        self._context(context)
        try:
            if str(uuid.UUID(task_id)) != task_id:
                raise ValueError
            task = json.loads((self.root / task_id / "task.json").read_text())
        except (ValueError, FileNotFoundError, OSError):
            raise TrimError("TASK_NOT_FOUND", "Tarefa não encontrada.", 404) from None
        if task.get("_userId") != context.user_id or task.get("_projectId") != context.project_id:
            raise TrimError("TASK_NOT_FOUND", "Tarefa não encontrada.", 404)
        return task

    def get(self, task_id, context):
        return self.public(self._load(task_id, context))

    def submit(self, upload, start, end, mode, context):
        self._context(context)
        if self._closed:
            raise TrimError("SERVICE_CLOSED", "O serviço está a terminar.", 503)
        max_bytes, max_duration = ((2_000_000_000, 1800) if context.profile == "premium"
                                   else (200_000_000, 300))
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

    def _clean(self, job, keep_result=False):
        directory = self.root / job.task["id"]
        for path in directory.iterdir():
            if path.name == "task.json" or (keep_result and path.name.startswith("result.")):
                continue
            if path.is_file():
                path.unlink(missing_ok=True)

    def _stop(self, process):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

    def _execute(self, job, command, duration, deadline):
        # A file, not an unread stderr pipe, prevents deadlock on verbose failures.
        with tempfile.TemporaryFile() as errors:
            try:
                process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors)
            except FileNotFoundError:
                raise TrimError("FFMPEG_UNAVAILABLE", "FFmpeg não está disponível.", 503) from None
            try:
                os.set_blocking(process.stdout.fileno(), False)
                pending = b""
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    while process.poll() is None:
                        if job.cancelled.is_set():
                            raise TrimError("CANCELLED", "Tarefa cancelada.")
                        if time.monotonic() >= deadline:
                            raise TrimError("PROCESSING_TIMEOUT", "O tempo máximo de processamento foi excedido.")
                        for key, _ in selector.select(timeout=0.1):
                            chunk = os.read(key.fileobj.fileno(), 65536)
                            if not chunk:
                                selector.unregister(key.fileobj)
                                continue
                            pending += chunk
                            while b"\n" in pending:
                                line, pending = pending.split(b"\n", 1)
                                if line.startswith(b"out_time_us="):
                                    try:
                                        elapsed = int(line.split(b"=", 1)[1]) / 1_000_000
                                    except ValueError:
                                        continue
                                    with job.lock:
                                        if not job.cancelled.is_set():
                                            job.task["progress"] = max(job.task["progress"], min(99, int(elapsed / duration * 100)))
                                            self._save(job.task)
                if process.returncode:
                    errors.seek(0)
                    LOGGER.error("FFmpeg trim %s: %s", job.task["id"], errors.read()[-2000:].decode(errors="replace"))
                    raise TrimError("PROCESSING_FAILED", "O processamento falhou. Tente novamente.", 422)
            finally:
                self._stop(process)
                process.stdout.close()

    def _run(self, job, info):
        task = job.task
        directory = self.root / task["id"]
        output = directory / f"result.{info.container}"
        deadline = time.monotonic() + self.timeout
        try:
            with job.lock:
                if job.cancelled.is_set():
                    return
                task.update(status="processing", startedAt=_now())
                self._save(task)
            command = build_trim_command(directory / "input", output, info, task,
                                         probe_timeout=min(60, max(0.01, deadline - time.monotonic())))
            duration = task["effectiveEndSeconds"] - task["effectiveStartSeconds"]
            self._execute(job, command, duration, deadline)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TrimError("PROCESSING_TIMEOUT", "O tempo máximo de processamento foi excedido.")
            result = probe_video(output, timeout=min(60, remaining))
            if (result.width, result.height) != (info.width, info.height):
                raise TrimError("INVALID_RESULT", "A resolução do resultado não corresponde ao original.", 422)
            if result.has_audio != info.has_audio:
                raise TrimError("INVALID_RESULT", "O áudio do resultado não corresponde ao original.", 422)
            with job.lock:
                if job.cancelled.is_set():
                    return
                if time.monotonic() >= deadline:
                    raise TrimError("PROCESSING_TIMEOUT", "O tempo máximo de processamento foi excedido.")
                task["result"] = {"duration": result.duration, "width": result.width,
                                  "height": result.height, "fps": float(result.fps),
                                  "size": output.stat().st_size, "hasAudio": result.has_audio}
                # This hook publishes into the library and commits quota. It must
                # compensate any partial integration if it raises an exception.
                self.hooks.complete(job.context, self.public(task), output)
                if time.monotonic() >= deadline:
                    raise TrimError("PROCESSING_TIMEOUT", "O tempo máximo de processamento foi excedido.")
                task.update(status="completed", progress=100, finishedAt=_now())
                self._save(task)
        except Exception as error:
            with job.lock:
                if not job.cancelled.is_set():
                    task.update(status="failed", finishedAt=_now(), error=str(error),
                                errorCode=getattr(error, "code", "PROCESSING_FAILED"))
                    self._save(task)
                    self._abort(job.context, task)
        finally:
            with job.lock:
                self._clean(job, keep_result=task["status"] == "completed")
            with self._lock:
                self._jobs.pop(task["id"], None)

    def cancel(self, task_id, context):
        self._load(task_id, context)
        with self._lock:
            job = self._jobs.get(task_id)
        if job is None:
            raise TrimError("TASK_NOT_ACTIVE", "A tarefa já não está ativa.", 409)
        with job.lock:
            if job.task["status"] not in ACTIVE:
                raise TrimError("TASK_NOT_ACTIVE", "A tarefa já não está ativa.", 409)
            job.cancelled.set()
            job.task.update(status="cancelled", finishedAt=_now())
            self._save(job.task)
            self._abort(context, job.task)
            # The running process observes cancellation; queued tasks need no work.
            if "startedAt" not in job.task:
                self._clean(job)
            return self.public(job.task)

    def download(self, task_id, context):
        task = self._load(task_id, context)
        if task["status"] != "completed":
            raise TrimError("RESULT_NOT_READY", "O resultado ainda não está disponível.", 409)
        output = self.root / task_id / f"result.{task['outputFormat']}"
        if not output.is_file():
            raise TrimError("RESULT_NOT_FOUND", "O resultado não foi encontrado.", 404)
        return output, task["downloadName"]

    def close(self):
        self._retry_stop.set()
        if threading.current_thread() is not self._retry_thread:
            self._retry_thread.join()
        with self._lock:
            self._closed = True
            jobs = list(self._jobs.values())
        for job in jobs:
            if job.task["status"] in ACTIVE:
                try:
                    self.cancel(job.task["id"], job.context)
                except TrimError as error:
                    if error.code != "TASK_NOT_ACTIVE":
                        raise
        self._executor.shutdown(wait=True)


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
        request.max_content_length = (2_000_000_000 if caller.profile == "premium" else 200_000_000) + 131072
        video = request.files.get("video")
        if video is None:
            raise TrimError("MISSING_VIDEO", "É necessário enviar um vídeo.")
        task, status = service.submit(video, request.form.get("startSeconds"),
                                      request.form.get("endSeconds"), request.form.get("mode", "fast"), caller)
        return jsonify(task), status

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
