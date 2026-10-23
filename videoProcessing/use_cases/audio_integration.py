from use_cases.audio import AudioService, create_audio_blueprint
from utils.integration import register_video_service


def register_audio(app, task_root):
    return register_video_service(app, task_root, AudioService, create_audio_blueprint, 'audio')
