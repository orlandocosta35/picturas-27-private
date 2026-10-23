"""Register UC1 and start its existing recovery and cleanup lifecycle."""
from pathlib import Path
import threading

from use_cases import resize


def register_resize(app, task_root):
    resize.TASK_ROOT = Path(task_root)
    resize.TASK_ROOT.mkdir(parents=True, exist_ok=True)
    app.register_blueprint(resize.blueprint)
    resize.recover_tasks()
    maintenance = threading.Thread(
        target=resize.maintenance_loop, name="video-task-cleanup", daemon=True,
    )
    maintenance.start()
    app.extensions["video_resize_maintenance"] = maintenance
