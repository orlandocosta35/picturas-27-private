"""UC-VID-005: concatenação de vídeos.

Quando as entradas são compatíveis segundo a RN7, a concatenação usa o concat
demuxer do FFmpeg com cópia de streams, sem perda de qualidade. Quando não são,
o pedido é recusado com CONVERSION_REQUIRED (antes de criar tarefa ou reservar
quota) e, se o utilizador confirmar (convert=true), as entradas são recodificadas
para a resolução, o FPS e o formato do primeiro vídeo (REQ-VID-CON-012 revisto).

O ConcatService reutiliza do VideoTaskService (utils/tasks.py) a fila, a
recuperação no arranque, o cancelamento, o timeout e as compensações de
quota/biblioteca. Muda apenas a receção das entradas (submit) e o processamento
(_run), porque o _run base só trata uma entrada.
"""

from dataclasses import dataclass
from fractions import Fraction
import json
import math
from pathlib import Path
import shutil
import time
import uuid

from flask import Blueprint, jsonify, request, send_file
from werkzeug.exceptions import RequestEntityTooLarge
from werkzeug.utils import secure_filename

from utils.common import VideoError, VideoJob, profile_limits, utc_now
from utils.media import audio_notice, probe_json, select_audio
from utils.tasks import VideoTaskService


MIN_VIDEOS = 2
MAX_VIDEOS = {"free": 5, "premium": 20}
# RN2 comum: os limites por vídeo vêm de profile_limits() (os mesmos valores do
# compose usados pelo resize, trim e áudio).
MIB = 1024 * 1024
# RN4: tolerância de 0,1 s por vídeo concatenado.
DURATION_TOLERANCE = 0.1
# Conversão: FPS máximo do resultado e taxa/canais comuns do áudio.
MAX_CONVERT_FPS = 60
AUDIO_RATE = 48000

# RN7: campos que têm de coincidir entre todas as entradas.
VIDEO_KEYS = ("codec_name", "profile", "width", "height", "pix_fmt", "time_base", "r_frame_rate")
AUDIO_KEYS = ("codec_name", "sample_rate", "channels", "time_base")
FIELD_NAMES = {
    "container": "formato do ficheiro", "layout": "faixas do ficheiro", "rotation": "rotação", "codec_name": "codec de vídeo", "profile": "perfil do codec",
    "width": "largura", "height": "altura", "pix_fmt": "formato de píxel",
    "time_base": "base temporal do vídeo", "r_frame_rate": "FPS", "audio": "presença de áudio",
    "audio_codec_name": "codec de áudio", "audio_sample_rate": "frequência do áudio",
    "audio_channels": "canais de áudio", "audio_time_base": "base temporal do áudio",
}


class ConcatError(VideoError):
    def __init__(self, code, message, status=400, **details):
        super().__init__(code, message, status, **details)
        self.message = message


@dataclass(frozen=True)
class ConcatInput:
    path: Path
    container: str
    duration: float
    size: int
    video: dict
    audio: dict | None
    # Campos usados na conversão e nos avisos.
    audio_index: int | None = None
    layout: str = ""
    rotation: int = 0
    fps: Fraction = Fraction(0)
    notice: str | None = None

    @property
    def display(self):
        """Largura e altura como o vídeo é mostrado (com a rotação aplicada)."""
        width, height = self.video["width"], self.video["height"]
        return (height, width) if self.rotation % 180 == 90 else (width, height)


def _ffprobe(path, timeout=60, input_options=()):
    # As opções de entrada (ex.: cabeçalhos HTTP) têm de vir antes do ficheiro.
    try:
        return probe_json(path, [*input_options, "-show_format", "-show_streams"], timeout)
    except ConcatError:
        raise
    except VideoError as error:
        # Mesmos códigos; ConcatError permite indicar a posição do vídeo (index).
        raise ConcatError(error.code, str(error), error.status) from None


def _container(fmt, video):
    names = set(fmt.get("format_name", "").split(","))
    if "mp4" in names or "mov" in names:
        return "mov" if fmt.get("tags", {}).get("major_brand", "").strip() == "qt" else "mp4"
    if "webm" in names and video.get("codec_name") in {"vp8", "vp9", "av1"}:
        return "webm"
    raise ConcatError("UNSUPPORTED_FORMAT", "O formato deste vídeo não é suportado.", 415)


def _rotation(video):
    for item in video.get("side_data_list", []):
        if "rotation" in item:
            try:
                return int(round(float(item["rotation"]))) % 360
            except (TypeError, ValueError):
                return 0
    try:
        return int(video.get("tags", {}).get("rotate", 0)) % 360
    except (TypeError, ValueError):
        return 0


def probe_input(path):
    """Lê o conteúdo real do ficheiro; a extensão não conta como prova."""
    path = Path(path)
    return _describe(_ffprobe(path), path, path.stat().st_size)


def inspect_source(url, headers=None, timeout=30):
    """Lê os metadados de um vídeo servido por HTTP(S) sem o descarregar todo.

    O ffprobe pede só os bytes de que precisa (cabeçalho e índice) através de
    pedidos com Range. Os serviços internos usam certificados autoassinados.
    """
    options = ["-tls_verify", "0", "-rw_timeout", str(timeout * 1_000_000)]
    if headers:
        options += ["-headers", "".join(f"{key}: {value}\r\n" for key, value in headers.items())]
    data = _ffprobe(url, timeout, options)
    try:
        size = int(data.get("format", {}).get("size") or 0)
    except ValueError:
        size = 0
    return _describe(data, url, size)


def _describe(data, path, size):
    streams = data.get("streams", [])
    videos = [s for s in streams if s.get("codec_type") == "video"
              and not s.get("disposition", {}).get("attached_pic")]
    if len(videos) != 1:
        raise ConcatError("UNSUPPORTED_STREAMS", "O vídeo tem de ter exatamente uma faixa de vídeo.", 415)
    # REQ-VID-COM-005 (revisto): usa-se a primeira faixa de áudio legível; as
    # outras (ex.: o áudio espacial APAC dos iPhones) são ignoradas com aviso.
    audio, ignored = select_audio(streams)
    fmt, video = data.get("format", {}), videos[0]
    try:
        duration = float(video.get("duration", fmt.get("duration")))
        if not math.isfinite(duration) or duration <= 0 or Fraction(video["r_frame_rate"]) <= 0:
            raise ValueError
        fps = Fraction(video.get("avg_frame_rate") or "0/1")
        if fps <= 0:
            fps = Fraction(video["r_frame_rate"])
        # FPS variável é aceite (decisão do grupo, só no UC5): a cópia de streams
        # mantém o timestamp de cada frame. A RN7 compara o FPS nominal (r_frame_rate).
    except (KeyError, TypeError, ValueError, ZeroDivisionError):
        raise ConcatError("UNREADABLE_VIDEO", "Não foi possível ler este vídeo.", 422) from None
    return ConcatInput(
        path=path, container=_container(fmt, video), duration=duration, size=size,
        video={key: video.get(key) for key in VIDEO_KEYS},
        audio={key: audio.get(key) for key in AUDIO_KEYS} if audio else None,
        audio_index=audio.get("index") if audio else None,
        # O concat demuxer associa as faixas pela posição, por isso a ordem e o
        # tipo de todas as faixas têm de coincidir para a cópia direta.
        layout=",".join(s.get("codec_type", "?") for s in streams),
        rotation=_rotation(video), fps=fps, notice=audio_notice(audio, ignored),
    )


def compatibility_signature(item):
    """Os campos da RN7, pela ordem em que são comparados.

    É a mesma lista que a interface recebe para avisar de incompatibilidades
    antes do pedido, por isso o aviso e a validação nunca divergem.
    """
    entries = [("container", item.container)]
    entries += [(key, item.video[key]) for key in VIDEO_KEYS]
    entries.append(("rotation", item.rotation))
    entries.append(("audio", item.audio is not None))
    if item.audio is not None:
        entries += [(f"audio_{key}", item.audio[key]) for key in AUDIO_KEYS]
    # Por último, para os campos mais concretos serem indicados primeiro.
    entries.append(("layout", item.layout))
    return entries


def describe(item):
    """Metadados para a interface (REQ-VID-CON-007)."""
    width, height = item.display
    return {
        "duration": item.duration, "size": item.size, "container": item.container,
        "width": width, "height": height, "audioNotice": item.notice,
        "fps": round(float(Fraction(item.video["r_frame_rate"])), 3),
        "videoCodec": item.video["codec_name"], "hasAudio": item.audio is not None,
        "audioCodec": item.audio["codec_name"] if item.audio else None,
        "compatibility": [{"field": field, "label": FIELD_NAMES[field], "value": str(value)}
                          for field, value in compatibility_signature(item)],
    }


def validate_count(count, profile):
    """RN1 e RN3; não precisa de ler os ficheiros, por isso corre primeiro."""
    if profile not in MAX_VIDEOS:
        raise ConcatError("PROFILE_NOT_ALLOWED", "Este perfil não pode processar vídeo.", 403)
    if count < MIN_VIDEOS:
        raise ConcatError("TOO_FEW_VIDEOS", "Selecione pelo menos dois vídeos para concatenar.")
    if count > MAX_VIDEOS[profile]:
        raise ConcatError("TOO_MANY_VIDEOS",
                          f"O perfil permite concatenar no máximo {MAX_VIDEOS[profile]} vídeos.",
                          maxVideos=MAX_VIDEOS[profile],
                          suggestPremium=profile == "free" and count <= MAX_VIDEOS["premium"])


def validate_limits(inputs, profile):
    """Limites individuais de duração e tamanho do perfil (RN2 comum)."""
    max_size, max_duration = profile_limits(profile)
    premium_size, premium_duration = profile_limits("premium")
    for index, item in enumerate(inputs):
        if item.duration > max_duration:
            raise ConcatError("VIDEO_TOO_LONG",
                              f"O vídeo {index + 1} excede o limite de {int(max_duration // 60)} minutos do perfil.",
                              index=index,
                              suggestPremium=profile == "free" and item.duration <= premium_duration)
        if item.size > max_size:
            raise ConcatError("VIDEO_TOO_LARGE",
                              f"O vídeo {index + 1} excede o limite de {max_size // MIB} MiB do perfil.",
                              413, index=index,
                              suggestPremium=profile == "free" and item.size <= premium_size)


def find_mismatch(inputs):
    """RN7: compara todas as entradas com a primeira e indica o primeiro campo diferente."""
    reference = compatibility_signature(inputs[0])
    for index, item in enumerate(inputs[1:], start=1):
        # "audio" vem antes dos campos de áudio, por isso listas de tamanho
        # diferente (um com áudio, outro sem) param aí.
        mismatch = next((field for (field, expected), (_, actual)
                         in zip(reference, compatibility_signature(item))
                         if expected != actual), None)
        if mismatch:
            return {"index": index, "field": mismatch,
                    "detail": f"O vídeo {index + 1} difere do primeiro em: {FIELD_NAMES[mismatch]}."}
    return None


def conversion_target(first):
    """Formato do resultado convertido: o do primeiro vídeo da sequência."""
    width, height = (side - side % 2 for side in first.display)  # H.264 exige lados pares
    fps = min(first.fps, Fraction(MAX_CONVERT_FPS))
    webm = first.container == "webm"
    return {"width": width, "height": height, "fps": str(fps), "fpsValue": round(float(fps), 3),
            "container": first.container, "videoCodec": "vp9" if webm else "h264",
            "audioCodec": "opus" if webm else "aac"}


def prepare_inputs(paths, profile, convert=False):
    """Todas as validações que antecedem a aceitação do pedido, pela ordem do UC.

    Devolve (entradas, alvo da conversão ou None se a cópia direta é possível).
    """
    validate_count(len(paths), profile)
    inputs = []
    for index, path in enumerate(paths):
        try:
            inputs.append(probe_input(path))
        except ConcatError as error:
            error.details["index"] = index
            raise
    validate_limits(inputs, profile)
    mismatch = find_mismatch(inputs)
    if mismatch is None:
        return inputs, None
    target = conversion_target(inputs[0])
    if not convert:
        # Pede confirmação: converter demora mais e recodifica a imagem.
        raise ConcatError("CONVERSION_REQUIRED",
                          "Os vídeos não são compatíveis para concatenação direta. "
                          "Podem ser convertidos para o formato do primeiro vídeo.",
                          409, target=target, **mismatch)
    return inputs, target


def write_list_file(inputs, list_path):
    # Sintaxe do concat demuxer: aspas simples, escapando ' como '\''.
    lines = ["ffconcat version 1.0"]
    for item in inputs:
        escaped = str(Path(item.path).resolve()).replace("'", "'\\''")
        lines.append(f"file '{escaped}'")
    Path(list_path).write_text("\n".join(lines) + "\n")


def build_concat_command(list_path, output_path, container, audio_index=None):
    # Sem -xerror: o AAC de cada ficheiro termina uns ms depois do vídeo, o que gera
    # um aviso "Non-monotonic DTS" na junção que o FFmpeg corrige sozinho. A duração
    # final é verificada depois (RN4), por isso um resultado errado não passa.
    command = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
               "-f", "concat", "-safe", "0", "-i", str(list_path),
               "-map", "0:v:0", "-sn", "-dn", "-c", "copy"]
    if audio_index is not None:
        # Só a faixa de áudio escolhida; as faixas coincidem em todas as entradas (RN7).
        command[command.index("-sn"):command.index("-sn")] = ["-map", f"0:{audio_index}"]
    if container in {"mp4", "mov"}:
        command += ["-movflags", "+faststart"]
    return command + ["-progress", "pipe:1", "-stats_period", "1", str(output_path)]


def build_convert_command(inputs, output_path, target):
    """Recodifica e junta as entradas com o filtro concat (REQ-VID-CON-012 revisto).

    Cada vídeo é ajustado à resolução do alvo sem deformar (margens pretas), ao
    FPS do alvo e a 8 bits 4:2:0. O áudio é normalizado para 48 kHz estéreo; um
    vídeo sem áudio recebe silêncio, para a imagem e o som não se desalinharem.
    """
    width, height, fps = target["width"], target["height"], target["fps"]
    with_audio = any(item.audio is not None for item in inputs)
    command = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y"]
    filters, pads = [], []
    for index, item in enumerate(inputs):
        command += ["-i", str(Path(item.path).resolve())]
        duration = f"{item.duration:.6f}"
        filters.append(f"[{index}:v:0]setpts=PTS-STARTPTS,trim=duration={duration},"
                       f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
                       f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,"
                       f"fps={fps},format=yuv420p[v{index}]")
        pads.append(f"[v{index}]")
        if with_audio:
            source = (f"[{index}:{item.audio_index}]asetpts=PTS-STARTPTS," if item.audio is not None
                      else f"anullsrc=r={AUDIO_RATE}:cl=stereo,")
            filters.append(f"{source}aresample={AUDIO_RATE},"
                           f"aformat=sample_fmts=fltp:channel_layouts=stereo,"
                           f"apad,atrim=duration={duration}[a{index}]")
            pads.append(f"[a{index}]")
    filters.append("".join(pads) + f"concat=n={len(inputs)}:v=1:a={int(with_audio)}[v]"
                   + ("[a]" if with_audio else ""))
    command += ["-filter_complex", ";".join(filters), "-map", "[v]"]
    if with_audio:
        command += ["-map", "[a]"]
    if target["container"] == "webm":
        command += ["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-deadline", "realtime",
                    "-cpu-used", "8", "-row-mt", "1", "-c:a", "libopus", "-b:a", "128k"]
    else:
        command += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]
    return command + ["-progress", "pipe:1", "-stats_period", "1", str(output_path)]


def verify_result(output_path, inputs, target=None):
    """RN4 / REQ-VID-CON-008, mais resolução e áudio iguais às entradas."""
    try:
        result = probe_input(output_path)
    except ConcatError:
        raise ConcatError("INVALID_RESULT", "Não foi possível ler o vídeo resultante.", 422) from None
    expected = sum(item.duration for item in inputs)
    if abs(result.duration - expected) > DURATION_TOLERANCE * len(inputs):
        raise ConcatError("DURATION_MISMATCH",
                          "A duração do resultado não corresponde à soma das durações.", 422,
                          expected=expected, actual=result.duration)
    first = inputs[0]
    size = (target["width"], target["height"]) if target else (first.video["width"], first.video["height"])
    if (result.video["width"], result.video["height"]) != size:
        raise ConcatError("INVALID_RESULT", "A resolução do resultado não corresponde às entradas.", 422)
    # Na conversão, o resultado tem áudio se alguma entrada tiver.
    has_audio = any(item.audio is not None for item in (inputs if target else inputs[:1]))
    if (result.audio is not None) != has_audio:
        raise ConcatError("INVALID_RESULT", "O áudio do resultado não corresponde às entradas.", 422)
    return {"duration": result.duration, "width": result.video["width"],
            "height": result.video["height"], "fps": float(Fraction(result.video["r_frame_rate"])),
            "size": result.size, "hasAudio": result.audio is not None, "inputs": len(inputs)}


class ConcatService(VideoTaskService):
    """Tarefas de concatenação persistentes em <task_root>/concat/<id>/."""

    namespace = "concat"

    def submit(self, uploads, context, convert=False):
        self._context(context)
        if self._closed:
            raise ConcatError("SERVICE_CLOSED", "O serviço está a terminar.", 503)
        validate_count(len(uploads), context.profile)
        max_bytes = profile_limits(context.profile)[0]
        task_id = str(uuid.uuid4())
        directory = self.root / task_id
        directory.mkdir()
        accepted = False
        reservation_attempted = False
        task = None
        try:
            paths = []
            for index, upload in enumerate(uploads):
                path = directory / f"input_{index:02d}"
                size = 0
                with path.open("wb") as output:
                    while chunk := upload.stream.read(1024 * 1024):
                        size += len(chunk)
                        if size > max_bytes:
                            raise ConcatError("VIDEO_TOO_LARGE",
                                              f"O vídeo {index + 1} excede o limite de {max_bytes // MIB} MiB do perfil.",
                                              413, index=index,
                                              suggestPremium=context.profile == "free")
                        output.write(chunk)
                paths.append(path)
            inputs, target = prepare_inputs(paths, context.profile, convert)
            if target is None:
                write_list_file(inputs, directory / "list.txt")
            container = inputs[0].container
            names = [secure_filename(u.filename or "") or f"video_{i + 1}" for i, u in enumerate(uploads)]
            task = {"id": task_id, "status": "queued", "progress": 0, "createdAt": utc_now(),
                    "outputFormat": container,
                    # RN6; o projects guarda por ID de tarefa, por isso nomes iguais não se substituem.
                    "downloadName": f"{Path(names[0]).stem}_concatenado.{container}",
                    "inputs": [{"name": name, "duration": item.duration}
                               for name, item in zip(names, inputs)],
                    "expectedDuration": sum(item.duration for item in inputs),
                    # "copy" (sem perda) ou "convert" (recodificado para target).
                    "mode": "copy" if target is None else "convert", "target": target,
                    "warnings": [f"Vídeo {index + 1}: {item.notice}"
                                 for index, item in enumerate(inputs) if item.notice],
                    "_userId": context.user_id, "_projectId": context.project_id,
                    "_profile": context.profile}
            # Como no trim: registar antes de reservar, para que uma falha a meio
            # nunca deixe uma reserva sem tarefa associada.
            self._save(task)
            reservation_attempted = True
            self.hooks.accept(context, self.public(task))
            accepted = True
            self._save(task)
            job = VideoJob(task, context)
            with self._lock:
                self._jobs[task_id] = job
            response = self.public(task)
            self._executor.submit(self._run, job, inputs)
            return response, 202
        except Exception:
            if reservation_attempted:
                task.update(status="failed", finishedAt=utc_now())
                self._abort(context, task)
                with self._lock:
                    self._jobs.pop(task_id, None)
                self._clean(VideoJob(task, context))
            raise
        finally:
            if not accepted and not (task and task.get("_abortPending")):
                shutil.rmtree(directory, ignore_errors=True)

    def _run(self, job, inputs):
        task = job.task
        directory = self.root / task["id"]
        output = directory / f"result.{task['outputFormat']}"
        deadline = time.monotonic() + self.timeout
        try:
            with job.lock:
                if job.cancelled.is_set():
                    return
                task.update(status="processing", startedAt=utc_now())
                self._save(task)
            target = task.get("target")
            command = (build_convert_command(inputs, output, target) if target
                       else build_concat_command(directory / "list.txt", output, task["outputFormat"],
                                                 inputs[0].audio_index))
            self._execute(job, command, task["expectedDuration"], deadline)
            if time.monotonic() >= deadline:
                raise ConcatError("PROCESSING_TIMEOUT", "O tempo máximo de processamento foi excedido.")
            result = verify_result(output, inputs, target)
            with job.lock:
                if job.cancelled.is_set():
                    return
                if time.monotonic() >= deadline:
                    raise ConcatError("PROCESSING_TIMEOUT", "O tempo máximo de processamento foi excedido.")
                task["result"] = result
                # Publica na biblioteca e consome a quota; tem de compensar se falhar.
                self.hooks.complete(job.context, self.public(task), output)
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


def create_concat_blueprint(service, context_provider, library_provider=None):
    """Mesmas regras do trim: context_provider() devolve um contexto de confiança.

    library_provider(context), se existir, devolve a biblioteca do utilizador já
    com os metadados de cada vídeo (REQ-VID-CON-007).
    """
    blueprint = Blueprint("video_concat", __name__, url_prefix="/video/concat")

    @blueprint.errorhandler(VideoError)
    def handle_error(error):
        return jsonify(error=str(error), code=error.code, **error.details), error.status

    @blueprint.errorhandler(RequestEntityTooLarge)
    def handle_large_upload(error):
        return jsonify(error="Os vídeos excedem o tamanho permitido para o perfil.", code="INPUT_TOO_LARGE"), 413

    def context():
        return service._context(context_provider())

    @blueprint.post("")
    def submit():
        caller = context()
        # Limite por pedido; o limite de cada vídeo é verificado durante a receção.
        request.max_content_length = MAX_VIDEOS[caller.profile] * profile_limits(caller.profile)[0] + MIB
        # A ordem dos campos "videos" no multipart é a ordem da concatenação (RN2).
        task, status = service.submit(request.files.getlist("videos"), caller,
                                      convert=request.form.get("convert") == "true")
        return jsonify(task), status

    if library_provider is not None:
        @blueprint.get("/library")
        def library():
            return jsonify(library_provider(context()))

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
