"""Unit tests for the UC4 domain rules."""

from fractions import Fraction
from pathlib import Path
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from use_cases.frames_domain import (  # noqa: E402
    frame_instants,
    frame_limits,
    frame_name,
    plan_frames,
)
from utils.common import VideoError, VideoInfo  # noqa: E402


INFO = VideoInfo(10, 1920, 1080, Fraction(25, 1), "mp4", True)


class FramesDomainTests(unittest.TestCase):
    def test_defaults_to_full_interval_one_fps_jpeg_quality_90(self):
        plan = plan_frames({}, INFO, "free", first_frame_bytes=100)
        self.assertEqual((plan.start_seconds, plan.end_seconds), (0, 10))
        self.assertEqual(plan.estimated_frames, 11)
        self.assertEqual((plan.image_format, plan.quality), ("jpeg", 90))
        self.assertEqual(plan.estimated_zip_bytes, 1100)

    def test_fps_cannot_exceed_source_fps(self):
        with self.assertRaisesRegex(VideoError, "exceeds"):
            plan_frames({"mode": "fps", "fps": 26}, INFO, "free")

    def test_every_n_requires_positive_integer(self):
        for value in (0, -1, 1.5, True, "bad", "1.5"):
            with self.subTest(value=value):
                with self.assertRaises(VideoError):
                    plan_frames({"mode": "every_n", "everyN": value}, INFO, "free")

    def test_form_values_are_accepted_for_integer_fields(self):
        plan = plan_frames(
            {"mode": "every_n", "everyN": "2", "quality": "90"},
            INFO,
            "free",
        )
        self.assertEqual(plan.every_n, 2)

    def test_png_ignores_jpeg_quality(self):
        plan = plan_frames({"format": "png", "quality": 90}, INFO, "free")
        self.assertIsNone(plan.quality)

    def test_limits_are_configurable(self):
        with patch.dict(os.environ, {"VIDEO_MAX_FRAMES_FREE": "2"}, clear=False):
            with self.assertRaisesRegex(VideoError, "exceeds"):
                plan_frames({}, INFO, "free")

    def test_instants_and_names_are_ordered(self):
        plan = plan_frames({"mode": "fps", "fps": 2, "startSeconds": 1, "endSeconds": 2},
                           INFO, "free")
        self.assertEqual(frame_instants(plan, INFO.fps), [1, 1.5, 2])
        self.assertEqual(frame_name(12, 3.5, "jpg"), "frame_000012_00m03s500ms.jpg")
        self.assertEqual(frame_name(1, 60.001, "png"), "frame_000001_01m00s001ms.png")

    def test_invalid_interval_is_rejected(self):
        with self.assertRaises(VideoError):
            plan_frames({"startSeconds": 5, "endSeconds": 5}, INFO, "free")


if __name__ == "__main__":
    unittest.main()
