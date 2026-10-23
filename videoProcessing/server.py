"""Video application entry point: configure storage and register use cases."""
import os
from pathlib import Path

from flask import Flask

from use_cases.resize_integration import register_resize
from use_cases.trim_integration import register_trim
from use_cases.audio_integration import register_audio
from use_cases.concat_integration import register_concat

app = Flask(__name__)
TASK_ROOT = Path(os.environ.get("VIDEO_TASK_ROOT", "/data/tasks"))
TASK_ROOT.mkdir(parents=True, exist_ok=True)

register_trim(app, TASK_ROOT)
register_audio(app, TASK_ROOT)
register_concat(app, TASK_ROOT)
register_resize(app, TASK_ROOT)
