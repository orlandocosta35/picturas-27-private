"""Register UC-VID-004 with the shared video task/quota lifecycle."""

from use_cases.frames import FramesService, create_frames_blueprint
from utils.integration import register_video_service


def register_frames(app, task_root):
    """Register frame extraction under the shared authenticated integration."""
    return register_video_service(
        app,
        task_root,
        FramesService,
        create_frames_blueprint,
        "frames",
    )
