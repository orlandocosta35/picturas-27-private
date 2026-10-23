"""Public contract for UC-VID-004 (video frame extraction).

This module contains the stable values shared by validation, HTTP handlers and
clients. Processing and FFmpeg execution belong in ``frames.py``.
"""
from typing import Final, Literal, TypedDict


FrameMode = Literal["fps", "every_n", "all"]
ImageFormat = Literal["jpeg", "png"]

FRAME_OPERATION: Final = "frames"
FRAME_AUDIENCE: Final = "video-frames"
DEFAULT_IMAGE_FORMAT: Final[ImageFormat] = "jpeg"
DEFAULT_JPEG_QUALITY: Final = 90

FRAME_MODES: Final = ("fps", "every_n", "all")
IMAGE_FORMATS: Final = ("jpeg", "png")


class FrameRequest(TypedDict, total=False):
    """Request body accepted by the UC4 processing endpoint.

    ``startSeconds`` and ``endSeconds`` default to the complete source video.
    The ``fps`` field is used by ``fps`` mode and ``everyN`` by ``every_n``.
    """

    startSeconds: float
    endSeconds: float
    mode: FrameMode
    fps: float
    everyN: int
    format: ImageFormat
    quality: int


class FrameEstimate(TypedDict):
    """Estimate returned before a task is created."""

    startSeconds: float
    endSeconds: float
    durationSeconds: float
    mode: FrameMode
    estimatedFrames: int
    estimatedZipBytes: int
    imageFormat: ImageFormat
    quality: int | None
    maxFrames: int
    maxZipBytes: int


class FrameResult(TypedDict):
    """Metadata published with a completed UC4 ZIP result."""

    processor: Literal["frames"]
    operation: Literal["frames"]
    frameCount: int
    zipBytes: int
    startSeconds: float
    endSeconds: float
    durationSeconds: float
    mode: FrameMode
    imageFormat: ImageFormat
    quality: int | None
    preview: list[str]
