"""Pure domain rules for UC-VID-004.

This module deliberately has no Flask or FFmpeg dependency.  It validates a
request against probed video metadata and produces the values needed by the
HTTP and processing layers.
"""
from dataclasses import dataclass
import math
import os
from fractions import Fraction
from typing import Any

from utils.common import EPSILON, VideoError, VideoInfo, finite_number
from use_cases.frames_contract import (
    DEFAULT_IMAGE_FORMAT,
    DEFAULT_JPEG_QUALITY,
    FRAME_MODES,
    IMAGE_FORMATS,
    FrameMode,
    ImageFormat,
)


@dataclass(frozen=True)
class FrameLimits:
    max_frames: int
    max_zip_bytes: int


@dataclass(frozen=True)
class FramePlan:
    start_seconds: float
    end_seconds: float
    duration_seconds: float
    mode: FrameMode
    fps: float | None
    every_n: int | None
    image_format: ImageFormat
    quality: int | None
    estimated_frames: int
    estimated_zip_bytes: int
    limits: FrameLimits


def frame_limits(profile: str) -> FrameLimits:
    """Return UC4 limits, with the documented MVP defaults."""
    premium = profile == "premium"
    suffix = "PREMIUM" if premium else "FREE"
    default_frames = 5000 if premium else 300
    default_zip = 2 * 1024**3 if premium else 200 * 1024**2
    try:
        max_frames = int(os.environ.get(f"VIDEO_MAX_FRAMES_{suffix}", default_frames))
        max_zip_bytes = int(
            os.environ.get(f"VIDEO_MAX_ZIP_SIZE_{suffix}", default_zip)
        )
    except (TypeError, ValueError):
        raise VideoError(
            "INVALID_CONFIGURATION",
            "Frame extraction limits are incorrectly configured.",
            500,
        ) from None
    if max_frames <= 0 or max_zip_bytes <= 0:
        raise VideoError(
            "INVALID_CONFIGURATION",
            "Frame extraction limits must be positive.",
            500,
        )
    return FrameLimits(max_frames, max_zip_bytes)


def _number(params: dict[str, Any], key: str, default: float | None = None) -> float:
    value = params.get(key, default)
    if value is None:
        raise VideoError("INVALID_FREQUENCY", f"{key} is required.")
    try:
        result = finite_number(value, key)
    except VideoError as error:
        raise VideoError("INVALID_FREQUENCY", str(error)) from None
    return result


def _positive_integer(params: dict[str, Any], key: str) -> int:
    value = params.get(key)
    if isinstance(value, bool):
        raise VideoError("INVALID_FREQUENCY", f"{key} must be a positive integer.")
    try:
        result = int(value)
    except (TypeError, ValueError, OverflowError):
        raise VideoError("INVALID_FREQUENCY", f"{key} must be a positive integer.") from None
    if isinstance(value, str):
        is_integer = value.strip() == str(result)
    else:
        is_integer = result == value
    if result <= 0 or not is_integer:
        raise VideoError("INVALID_FREQUENCY", f"{key} must be a positive integer.")
    return result


def _interval(params: dict[str, Any], info: VideoInfo) -> tuple[float, float]:
    start = finite_number(params.get("startSeconds", 0), "startSeconds")
    end = finite_number(params.get("endSeconds", info.duration), "endSeconds")
    if start < 0 or end > info.duration or start >= end:
        raise VideoError(
            "INVALID_INTERVAL",
            "The selected interval must be inside the video and have a positive duration.",
            startSeconds=start,
            endSeconds=end,
            durationSeconds=info.duration,
        )
    return start, end


def _format_and_quality(params: dict[str, Any]) -> tuple[ImageFormat, int | None]:
    image_format = params.get("format", DEFAULT_IMAGE_FORMAT)
    if image_format not in IMAGE_FORMATS:
        raise VideoError("INVALID_IMAGE_FORMAT", "Image format must be JPEG or PNG.")
    if image_format == "png":
        return image_format, None
    quality = params.get("quality", DEFAULT_JPEG_QUALITY)
    if isinstance(quality, bool):
        raise VideoError("INVALID_QUALITY", "JPEG quality must be an integer from 1 to 100.")
    try:
        quality = int(quality)
    except (TypeError, ValueError, OverflowError):
        raise VideoError("INVALID_QUALITY", "JPEG quality must be an integer from 1 to 100.") from None
    original_quality = params.get("quality", DEFAULT_JPEG_QUALITY)
    if isinstance(original_quality, str):
        is_integer = original_quality.strip() == str(quality)
    else:
        is_integer = quality == original_quality
    if quality < 1 or quality > 100 or not is_integer:
        raise VideoError("INVALID_QUALITY", "JPEG quality must be an integer from 1 to 100.")
    return image_format, quality


def _estimated_frames(mode: FrameMode, duration: float, fps: Fraction,
                      requested_fps: float | None, every_n: int | None) -> int:
    source_fps = float(fps)
    if mode == "fps":
        assert requested_fps is not None
        return max(1, math.floor(duration * requested_fps + EPSILON) + 1)
    if mode == "every_n":
        assert every_n is not None
        source_frames = max(1, math.ceil(duration * source_fps - EPSILON))
        return max(1, math.ceil(source_frames / every_n))
    source_frames = max(1, math.ceil(duration * source_fps - EPSILON))
    return source_frames


def plan_frames(
    params: dict[str, Any],
    info: VideoInfo,
    profile: str,
    first_frame_bytes: int = 0,
) -> FramePlan:
    """Validate UC4 parameters and return a processing-independent plan."""
    if not isinstance(params, dict):
        raise VideoError("INVALID_REQUEST", "Frame extraction parameters must be an object.")
    start, end = _interval(params, info)
    mode = params.get("mode", "fps")
    if mode not in FRAME_MODES:
        raise VideoError("INVALID_FREQUENCY", "Extraction mode is not supported.")

    requested_fps = None
    every_n = None
    if mode == "fps":
        requested_fps = _number(params, "fps", 1)
        if requested_fps <= 0:
            raise VideoError("INVALID_FREQUENCY", "fps must be positive.")
        if requested_fps > float(info.fps) + EPSILON:
            raise VideoError(
                "FREQUENCY_EXCEEDS_VIDEO_FPS",
                "The requested frequency exceeds the video's FPS.",
                maxFps=float(info.fps),
            )
    elif mode == "every_n":
        every_n = _positive_integer(params, "everyN")

    image_format, quality = _format_and_quality(params)
    duration = end - start
    estimated_frames = _estimated_frames(
        mode, duration, info.fps, requested_fps, every_n
    )
    limits = frame_limits(profile)
    if estimated_frames > limits.max_frames:
        raise VideoError(
            "FRAME_LIMIT_EXCEEDED",
            "The estimated number of frames exceeds the profile limit.",
            estimatedFrames=estimated_frames,
            maxFrames=limits.max_frames,
        )
    if isinstance(first_frame_bytes, bool) or not isinstance(first_frame_bytes, int) or first_frame_bytes < 0:
        raise VideoError("INVALID_ESTIMATE", "The first frame size must be a non-negative integer.")
    estimated_zip_bytes = first_frame_bytes * estimated_frames
    if estimated_zip_bytes > limits.max_zip_bytes:
        raise VideoError(
            "ZIP_SIZE_LIMIT_EXCEEDED",
            "The estimated ZIP size exceeds the profile limit.",
            estimatedZipBytes=estimated_zip_bytes,
            maxZipBytes=limits.max_zip_bytes,
        )
    return FramePlan(
        start, end, duration, mode, requested_fps, every_n, image_format, quality,
        estimated_frames, estimated_zip_bytes, limits,
    )


def frame_instants(plan: FramePlan, source_fps: Fraction) -> list[float]:
    """Return requested timestamps for deterministic preview/processing setup."""
    if plan.mode == "fps":
        assert plan.fps is not None
        count = plan.estimated_frames
        return [plan.start_seconds + index / plan.fps for index in range(count)
                if plan.start_seconds + index / plan.fps <= plan.end_seconds + EPSILON]
    if plan.mode == "every_n":
        assert plan.every_n is not None
        step = plan.every_n / float(source_fps)
        return [plan.start_seconds + index * step for index in range(plan.estimated_frames)
                if plan.start_seconds + index * step <= plan.end_seconds + EPSILON]
    step = 1 / float(source_fps)
    return [plan.start_seconds + index * step for index in range(plan.estimated_frames)
            if plan.start_seconds + index * step <= plan.end_seconds + EPSILON]


def frame_name(index: int, seconds: float, extension: str) -> str:
    """Create the RN5 filename, rounding only at the millisecond boundary."""
    if index < 0 or not math.isfinite(seconds) or seconds < 0:
        raise ValueError("index and seconds must be non-negative finite values")
    milliseconds = int(round(seconds * 1000))
    minutes, remainder = divmod(milliseconds, 60_000)
    whole_seconds, millis = divmod(remainder, 1000)
    return f"frame_{index:06d}_{minutes:02d}m{whole_seconds:02d}s{millis:03d}ms.{extension}"
