"""Persistent queue, progress, cancellation and compensation for video tasks."""
from concurrent.futures import ThreadPoolExecutor
import json
import logging
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from .common import ACTIVE, VideoError, VideoContext, VideoHooks, VideoJob, utc_now
from .media import probe_video

LOGGER = logging.getLogger(__name__)

class VideoTaskService:
    """Persistent video jobs with a local queue; no dependency on server.py.

    All hooks are mandatory, so exposing the Blueprint without shared quota/library
    integration cannot silently bypass those rules. Completion is serialized with
    cancellation; complete must roll back its own side effects if it raises.
    """

    namespace = None

    def __init__(self, task_root, hooks, timeout_seconds=1800):
        if not self.namespace:
            raise ValueError("A task namespace is required")
        if not isinstance(hooks, VideoHooks) or not all(callable(x) for x in (hooks.accept, hooks.complete, hooks.abort)):
            raise ValueError("VideoHooks com accept, complete e abort são obrigatórios")
        # A private namespace prevents touching the resize service's task files.
        self.root = Path(task_root) / self.namespace
        self.root.mkdir(parents=True, exist_ok=True)
        self.hooks = hooks
        self.timeout = timeout_seconds
        self._jobs = {}
        self._lock = threading.RLock()
        self._closed = False
        self._recover()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"video-{self.namespace}")
        self._retry_stop = threading.Event()
        self._retry_thread = threading.Thread(target=self._retry_loop, name=f"{self.namespace}-compensation", daemon=True)
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
                        context = VideoContext(task["_userId"], task["_profile"], task["_projectId"])
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
                context = VideoContext(task["_userId"], task["_profile"], task["_projectId"])
                if task["status"] in ACTIVE or task.get("_abortPending"):
                    if task["status"] in ACTIVE:
                        task.update(status="failed", finishedAt=utc_now(), errorCode="PROCESSING_INTERRUPTED",
                                    error="O processamento foi interrompido. Tente novamente.")
                    self._abort(context, task)
                self._clean(VideoJob(task, context), keep_result=task["status"] == "completed")
            except (ValueError, KeyError, OSError):
                LOGGER.exception("Não foi possível recuperar a tarefa %s", directory.name)

    @staticmethod
    def _context(context):
        if not isinstance(context, VideoContext) or not context.user_id:
            raise VideoError("AUTHENTICATION_REQUIRED", "É necessário iniciar sessão.", 401)
        if context.profile not in {"free", "premium"}:
            raise VideoError("PROFILE_NOT_ALLOWED", "O perfil Anónimo não pode processar vídeo.", 403)
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
            raise VideoError("TASK_NOT_FOUND", "Tarefa não encontrada.", 404) from None
        if task.get("_userId") != context.user_id or task.get("_projectId") != context.project_id:
            raise VideoError("TASK_NOT_FOUND", "Tarefa não encontrada.", 404)
        return task

    def get(self, task_id, context):
        return self.public(self._load(task_id, context))


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
                raise VideoError("FFMPEG_UNAVAILABLE", "FFmpeg não está disponível.", 503) from None
            try:
                os.set_blocking(process.stdout.fileno(), False)
                pending = b""
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    while process.poll() is None:
                        if job.cancelled.is_set():
                            raise VideoError("CANCELLED", "Tarefa cancelada.")
                        if time.monotonic() >= deadline:
                            raise VideoError("PROCESSING_TIMEOUT", "O tempo máximo de processamento foi excedido.")
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
                    LOGGER.error("FFmpeg vídeo %s: %s", job.task["id"], errors.read()[-2000:].decode(errors="replace"))
                    raise VideoError("PROCESSING_FAILED", "O processamento falhou. Tente novamente.", 422)
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
                task.update(status="processing", startedAt=utc_now())
                self._save(task)
            command = self._build_command(directory / "input", output, info, task,
                                          min(60, max(0.01, deadline - time.monotonic())))
            duration = task["effectiveEndSeconds"] - task["effectiveStartSeconds"]
            self._execute(job, command, duration, deadline)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise VideoError("PROCESSING_TIMEOUT", "O tempo máximo de processamento foi excedido.")
            result = probe_video(output, timeout=min(60, remaining))
            self._validate_result(info, result, task)
            with job.lock:
                if job.cancelled.is_set():
                    return
                if time.monotonic() >= deadline:
                    raise VideoError("PROCESSING_TIMEOUT", "O tempo máximo de processamento foi excedido.")
                task["result"] = {"duration": result.duration, "width": result.width,
                                  "height": result.height, "fps": float(result.fps),
                                  "size": output.stat().st_size, "hasAudio": result.has_audio}
                # This hook publishes into the library and commits quota. It must
                # compensate any partial integration if it raises an exception.
                self.hooks.complete(job.context, self.public(task), output)
                if time.monotonic() >= deadline:
                    raise VideoError("PROCESSING_TIMEOUT", "O tempo máximo de processamento foi excedido.")
                # Auxiliary inputs/private source copies must be gone before
                # exposing successful completion (UC3 RN7).
                self._clean(job, keep_result=True)
                task.update(status="completed", progress=100, finishedAt=utc_now())
                self._save(task)
        except Exception as error:
            with job.lock:
                if not job.cancelled.is_set():
                    task.update(status="failed", finishedAt=utc_now(), error=str(error),
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
            raise VideoError("TASK_NOT_ACTIVE", "A tarefa já não está ativa.", 409)
        with job.lock:
            if job.task["status"] not in ACTIVE:
                raise VideoError("TASK_NOT_ACTIVE", "A tarefa já não está ativa.", 409)
            job.cancelled.set()
            job.task.update(status="cancelled", finishedAt=utc_now())
            self._save(job.task)
            self._abort(context, job.task)
            # The running process observes cancellation; queued tasks need no work.
            if "startedAt" not in job.task:
                self._clean(job)
            return self.public(job.task)

    def download(self, task_id, context):
        task = self._load(task_id, context)
        if task["status"] != "completed":
            raise VideoError("RESULT_NOT_READY", "O resultado ainda não está disponível.", 409)
        output = self.root / task_id / f"result.{task['outputFormat']}"
        if not output.is_file():
            raise VideoError("RESULT_NOT_FOUND", "O resultado não foi encontrado.", 404)
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
                except VideoError as error:
                    if error.code != "TASK_NOT_ACTIVE":
                        raise
        self._executor.shutdown(wait=True)


    def _build_command(self, source, output, info, task, timeout):
        raise NotImplementedError

    def _validate_result(self, info, result, task):
        raise NotImplementedError
