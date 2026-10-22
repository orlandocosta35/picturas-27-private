"""Register UC2 using the common video-service integration."""
from use_cases.trim import TrimService, create_trim_blueprint
from utils.integration import register_video_service


def register_trim(app, task_root):
    return register_video_service(app, task_root, TrimService, create_trim_blueprint, "trim")
