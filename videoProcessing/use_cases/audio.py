"""UC-VID-003. Audio operations reuse the persistent video-task lifecycle."""
from dataclasses import asdict, dataclass, replace
import json
import math
from pathlib import Path
import shutil
import uuid

from flask import Blueprint, jsonify, request, send_file
from werkzeug.exceptions import RequestEntityTooLarge
from werkzeug.utils import secure_filename

from utils.common import VideoError, VideoJob, utc_now, profile_limits, EPSILON
from utils.media import audio_notice, probe_json, probe_video, select_audio
from utils.tasks import VideoTaskService

AUDIO_MAX_BYTES = 20_000_000  # RN2 says 20 MB; the MiB decision covers video inputs.


@dataclass(frozen=True)
class AudioInfo:
    duration: float
    format: str


def probe_audio(path):
    try:
        data = probe_json(path, ['-show_format', '-show_streams'])
    except VideoError as error:
        if error.code == 'UNREADABLE_VIDEO':
            raise VideoError('UNREADABLE_AUDIO', 'Could not read the audio file.', 422) from None
        raise
    streams = data.get('streams', [])
    audio = [s for s in streams if s.get('codec_type') == 'audio']
    video = [s for s in streams if s.get('codec_type') == 'video'
             and not s.get('disposition', {}).get('attached_pic')]
    formats = set(data.get('format', {}).get('format_name', '').split(','))
    supported = formats & {'mp3', 'wav', 'aac', 'ogg'}
    if len(audio) != 1 or video or not supported:
        raise VideoError('UNSUPPORTED_AUDIO', 'Choose an MP3, WAV, AAC or OGG file with one audio track.', 415)
    try:
        duration = float(audio[0].get('duration', data['format'].get('duration')))
        if not math.isfinite(duration) or duration <= 0:
            raise ValueError
    except (ValueError, TypeError, KeyError):
        raise VideoError('UNREADABLE_AUDIO', 'Could not determine the audio duration.', 422) from None
    return AudioInfo(duration, next(iter(supported)))


def number(params, key, default, minimum, maximum):
    try:
        value = float(params.get(key, default))
        if not math.isfinite(value) or not minimum <= value <= maximum:
            raise ValueError
        return value
    except (TypeError, ValueError, OverflowError):
        raise VideoError('INVALID_AUDIO_PARAMETERS', f'{key} must be between {minimum:g} and {maximum:g}.') from None


def plan_audio(info, original_duration, auxiliary, params):
    operation = params.get('operation')
    if operation not in {'volume', 'remove', 'overlay'}:
        raise VideoError('INVALID_AUDIO_OPERATION', 'Choose adjust volume, remove audio or overlay audio.')
    if operation != 'overlay' and not info.has_audio:
        raise VideoError('NO_AUDIO_TRACK', 'This video has no audio. You can only overlay a new audio track.')
    if operation != 'overlay' and auxiliary is not None:
        raise VideoError('UNEXPECTED_AUDIO', 'An additional audio file is only used for overlays.')
    result = dict(operation=operation, effectiveStartSeconds=0, effectiveEndSeconds=info.duration,
                  outputFormat=info.container, warnings=[])
    warnings = result['warnings']
    if operation == 'remove':
        if params.get('confirmRemove') != 'true':
            warnings.append(dict(code='REMOVE_AUDIO', message='The result will have no audio track. The original is preserved.'))
        return {**result, 'status': 'confirmation_required' if warnings else 'ready'}
    volume = number(params, 'volume', 100, 0, 300)
    fade_in = number(params, 'fadeIn', 0, 0, 5)
    fade_out = number(params, 'fadeOut', 0, 0, 5)
    effective = original_duration
    result.update(volume=volume, fadeIn=fade_in, fadeOut=fade_out)
    if operation == 'overlay':
        if auxiliary is None:
            raise VideoError('MISSING_AUDIO', 'Upload an audio file to overlay.')
        if auxiliary.duration > info.duration * 1.1 + EPSILON:
            raise VideoError('AUDIO_TOO_LONG', 'The audio duration cannot exceed 110% of the video duration.')
        mode = params.get('overlayMode')
        if mode not in {'mix', 'replace'}:
            raise VideoError('INVALID_OVERLAY_MODE', 'Choose Mix or Replace.')
        if not info.has_audio and mode != 'replace':
            raise VideoError('NO_AUDIO_TRACK', 'For a video without audio, choose Replace.')
        start = number(params, 'startSeconds', 0, 0, info.duration)
        if start >= info.duration:
            raise VideoError('INVALID_AUDIO_START', 'The start time must be before the end of the video.')
        remaining = info.duration - start
        short = auxiliary.duration < remaining - EPSILON
        policy = params.get('shortPolicy', '')
        if short and policy not in {'repeat', 'silence'}:
            return {**result, 'status': 'choice_required', 'requiredChoice': 'shortPolicy',
                    'message': 'The audio is shorter than the video. Choose Repeat or let it end.',
                    'audioDuration': auxiliary.duration, 'remainingDuration': remaining}
        repeat = short and policy == 'repeat'
        effective = remaining if repeat else min(auxiliary.duration, remaining)
        original_volume = number(params, 'originalVolume', 100, 0, 300) if mode == 'mix' else 0
        result.update(overlayMode=mode, startSeconds=start, repeat=repeat,
                      originalVolume=original_volume, auxiliaryDuration=auxiliary.duration,
                      shortPolicy=policy if short else None)
        if auxiliary.duration > remaining + EPSILON and params.get('confirmTrim') != 'true':
            warnings.append(dict(code='TRIM_AUDIO', message='The audio will be trimmed at the end of the video.'))
    else:
        original_volume = 0
    if fade_in + fade_out > effective + EPSILON:
        raise VideoError('INVALID_FADES', 'The combined fade length cannot exceed the effective audio duration.')
    if (volume > 100 or original_volume > 100) and params.get('confirmAmplification') != 'true':
        warnings.append(dict(code='AMPLIFICATION', message='Volume above 100% may cause clipping and distort the sound.'))
    if operation == 'volume' and volume == 0 and params.get('confirmZero') != 'true':
        warnings.append(dict(code='ZERO_VOLUME', message='0% mutes the sound. Choose Remove audio to delete the track.'))
    result['effectiveAudioDuration'] = effective
    return {**result, 'status': 'confirmation_required' if warnings else 'ready'}


def build_audio_command(source, destination, info, task):
    # The chosen readable track; '0:a:0' for tasks created before audioStreamIndex existed.
    original = f'0:{task["audioStreamIndex"]}' if task.get('audioStreamIndex') is not None else '0:a:0'
    command = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-y', '-i', str(source)]
    operation = task['operation']
    if operation == 'overlay':
        if task['repeat']:
            command += ['-stream_loop', '-1']
        command += ['-i', str(Path(source).parent / 'auxiliary')]
    command += ['-map', '0:v:0', '-c:v', 'copy', '-sn', '-dn']
    if operation == 'remove':
        command += ['-an']
    else:
        duration = info.duration
        effective = task['effectiveAudioDuration']
        audio_input = '1:a:0' if operation == 'overlay' else original
        chain = [f'atrim=duration={effective:.9f}', 'asetpts=PTS-STARTPTS', f'volume={task["volume"] / 100:.9f}']
        if task['fadeIn']:
            chain.append(f'afade=t=in:st=0:d={task["fadeIn"]:.9f}')
        if task['fadeOut']:
            chain.append(f'afade=t=out:st={effective - task["fadeOut"]:.9f}:d={task["fadeOut"]:.9f}')
        if operation == 'volume':
            offset = task.get('originalStartSeconds', 0)
            if offset < 0:
                chain += [f'atrim=start={-offset:.9f}', 'asetpts=PTS-STARTPTS']
            elif offset > 0:
                chain.append(f'adelay={offset * 1000:.6f}:all=1')
        if operation == 'overlay':
            chain.append(f'adelay={task["startSeconds"] * 1000:.6f}:all=1')
        chain += ['apad', f'atrim=duration={duration:.9f}']
        filters = f'[{audio_input}]' + ','.join(chain) + '[new]'
        if operation == 'overlay' and task['overlayMode'] == 'mix':
            offset = task.get('originalStartSeconds', 0)
            alignment = (f'atrim=start={-offset:.9f},asetpts=PTS-STARTPTS,' if offset < 0
                         else f'adelay={offset * 1000:.6f}:all=1,' if offset > 0 else '')
            filters += (f';[{original}]asetpts=PTS-STARTPTS,{alignment}volume={task["originalVolume"] / 100:.9f},'
                        f'apad,atrim=duration={duration:.9f}[original];'
                        '[original][new]amix=inputs=2:duration=longest:normalize=0:dropout_transition=0[audio]')
        else:
            filters += ';[new]anull[audio]'
        command += ['-filter_complex', filters, '-map', '[audio]',
                    '-c:a', 'libopus' if info.container == 'webm' else 'aac']
    command += ['-t', f'{info.duration:.9f}']
    if info.container in {'mp4', 'mov'}:
        command += ['-movflags', '+faststart']
    return command + ['-progress', 'pipe:1', '-stats_period', '1', str(destination)]


class AudioService(VideoTaskService):
    namespace = 'audio'

    def _build_command(self, source, output, info, task, timeout):
        return build_audio_command(source, output, info, task)

    def _validate_result(self, info, result, task):
        if ((result.width, result.height) != (info.width, info.height)
                or abs(float(result.fps) - float(info.fps)) > EPSILON
                or abs(result.duration - info.duration) > 0.1 + EPSILON
                or result.has_audio != (task['operation'] != 'remove')):
            raise VideoError('INVALID_RESULT', 'The result does not preserve the expected video stream, duration or audio track.', 422)

    def _stage(self, video, auxiliary, context, directory):
        limit, max_duration = profile_limits(context.profile)
        for upload, name, maximum in [(video, 'input', limit), (auxiliary, 'auxiliary', AUDIO_MAX_BYTES)]:
            if upload is None:
                continue
            size = 0
            with (directory / name).open('wb') as target:
                while chunk := upload.stream.read(1024 * 1024):
                    size += len(chunk)
                    if size > maximum:
                        raise VideoError('AUDIO_TOO_LARGE' if name == 'auxiliary' else 'INPUT_TOO_LARGE',
                                        'The audio file exceeds 20 MB.' if name == 'auxiliary' else 'The video exceeds the profile limit.', 413)
                    target.write(chunk)
        info = probe_video(directory / 'input')
        if info.duration > max_duration + EPSILON:
            raise VideoError('INPUT_TOO_LONG', 'The video exceeds the duration limit for this profile.')
        streams = probe_json(directory / 'input', ['-show_streams']).get('streams', [])
        # REQ-VID-COM-005 (revisto): use the first readable audio track, ignore the rest.
        chosen, ignored = select_audio(streams)
        audio = [chosen] if chosen else []
        info = replace(info, has_audio=chosen is not None)
        notice = audio_notice(chosen, ignored)
        try:
            original_duration = float(audio[0].get('duration', info.duration)) if audio else 0
            if not math.isfinite(original_duration) or original_duration <= 0:
                original_duration = info.duration if audio else 0
        except (ValueError, TypeError):
            original_duration = info.duration if audio else 0
        auxiliary_info = probe_audio(directory / 'auxiliary') if auxiliary else None
        if auxiliary_info and auxiliary_info.duration > info.duration * 1.1 + EPSILON:
            raise VideoError('AUDIO_TOO_LONG', 'The audio duration cannot exceed 110% of the video duration.')
        try:
            original_start = float(audio[0].get('start_time', info.start_time)) - info.start_time if audio else 0
            if not math.isfinite(original_start):
                raise ValueError
        except (ValueError, TypeError):
            raise VideoError('UNREADABLE_VIDEO', 'Could not determine the audio synchronization.', 422) from None
        audio_stream = dict(index=chosen['index'] if chosen else None, notice=notice)
        return info, original_duration, auxiliary_info, original_start, audio_stream

    def submit_audio(self, video, auxiliary, params, context, inspect=False):
        self._context(context)
        if self._closed:
            raise VideoError('SERVICE_CLOSED', 'The service is shutting down.', 503)
        task_id = str(uuid.uuid4())
        directory = self.root / task_id
        directory.mkdir()
        accepted = attempted = False
        task = None
        try:
            info, original_duration, aux, original_start, audio_stream = self._stage(video, auxiliary, context, directory)
            summary = dict(video={**asdict(info), 'fps': float(info.fps), 'audioDuration': original_duration,
                                  'audioNotice': audio_stream['notice']},
                           audio=asdict(aux) if aux else None)
            if inspect:
                return summary, 200
            plan = plan_audio(info, original_duration, aux, params)
            plan['originalStartSeconds'] = original_start
            plan['audioStreamIndex'] = audio_stream['index']
            if plan['status'] != 'ready':
                return {**plan, **summary}, 200
            original = Path(secure_filename(video.filename or 'video')).stem
            task = {**plan, 'sourceResultId': params.get('sourceResultId'), 'id': task_id, 'status': 'queued', 'progress': 0,
                    'createdAt': utc_now(), 'downloadName': f'{original}_audio_{plan["operation"]}.{info.container}',
                    '_userId': context.user_id, '_projectId': context.project_id, '_profile': context.profile}
            self._save(task)
            attempted = True
            self.hooks.accept(context, self.public(task))
            accepted = True
            job = VideoJob(task, context)
            with self._lock:
                self._jobs[task_id] = job
            response = self.public(task)
            self._executor.submit(self._run, job, info)
            return response, 202
        except Exception:
            if attempted:
                task.update(status='failed', finishedAt=utc_now())
                self._abort(context, task)
                with self._lock:
                    self._jobs.pop(task_id, None)
                self._clean(VideoJob(task, context))
            raise
        finally:
            if not accepted and not (task and task.get('_abortPending')):
                shutil.rmtree(directory, ignore_errors=True)


def create_audio_blueprint(service, context_provider):
    blueprint = Blueprint('video_audio', __name__, url_prefix='/video/audio')

    @blueprint.errorhandler(VideoError)
    def error_response(error):
        return jsonify(error=str(error), code=error.code, **error.details), error.status

    @blueprint.errorhandler(RequestEntityTooLarge)
    def too_large(error):
        return jsonify(error='The video or audio exceeds the file size limit.', code='INPUT_TOO_LARGE'), 413

    def context():
        return service._context(context_provider())

    def submit(inspect=False):
        caller = context()
        request.max_content_length = profile_limits(caller.profile)[0] + AUDIO_MAX_BYTES + 131072
        video = request.files.get('video')
        if video is None:
            raise VideoError('MISSING_VIDEO', 'The project video is required.')
        task, status = service.submit_audio(video, request.files.get('audio'), request.form, caller, inspect)
        return jsonify(task), status

    blueprint.add_url_rule('', 'submit', submit, methods=['POST'])
    blueprint.add_url_rule('/inspect', 'inspect', lambda: submit(True), methods=['POST'])

    @blueprint.get('/tasks')
    def list_tasks():
        caller = context()
        tasks = []
        for path in service.root.glob('*/task.json'):
            try:
                task = json.loads(path.read_text())
                if task.get('_userId') == caller.user_id and task.get('_projectId') == caller.project_id:
                    tasks.append(service.public(task))
            except (ValueError, OSError):
                continue
        return jsonify(sorted(tasks, key=lambda t: t.get('createdAt', ''), reverse=True))

    @blueprint.get('/tasks/<task_id>')
    def get_task(task_id):
        return jsonify(service.get(task_id, context()))

    @blueprint.delete('/tasks/<task_id>')
    def cancel(task_id):
        return jsonify(service.cancel(task_id, context()))

    @blueprint.get('/tasks/<task_id>/download')
    def download(task_id):
        output, name = service.download(task_id, context())
        return send_file(output, as_attachment=True, download_name=name)

    return blueprint
