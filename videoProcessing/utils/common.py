"""Shared error, context, task data and profile limits."""
from dataclasses import dataclass, field
from datetime import datetime, timezone
from fractions import Fraction
import math
import os
import threading

ACTIVE = {"queued", "processing"}
EPSILON = 1e-6

def profile_limits(profile):
    """Use the same Compose settings and binary defaults as resize."""
    premium = profile == "premium"
    suffix = "PREMIUM" if premium else "FREE"
    size = int(os.environ.get(f"VIDEO_MAX_SIZE_{suffix}",
                              str(2 * 1024 ** 3 if premium else 200 * 1024 ** 2)))
    duration = float(os.environ.get(f"VIDEO_MAX_DURATION_{suffix}",
                                    "1800" if premium else "300"))
    return size, duration


class VideoError(Exception):
    def __init__(self, code, message, status=400, **details):
        super().__init__(message)
        self.code, self.status, self.details = code, status, details


@dataclass(frozen=True)
class VideoContext:
    user_id: str
    profile: str
    project_id: str = ""


@dataclass(frozen=True)
class VideoHooks:
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
class VideoJob:
    task: dict
    context: VideoContext
    lock: object = field(default_factory=threading.RLock)
    cancelled: object = field(default_factory=threading.Event)


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def finite_number(value, name):
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        raise VideoError("INVALID_INTERVAL", f"{name} tem de ser um número finito.") from None
    if not math.isfinite(result):
        raise VideoError("INVALID_INTERVAL", f"{name} tem de ser um número finito.")
    return result
