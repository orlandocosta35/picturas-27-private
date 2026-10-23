"""Contract-level tests for UC-VID-004."""

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from use_cases.frames_contract import (  # noqa: E402
    DEFAULT_IMAGE_FORMAT,
    DEFAULT_JPEG_QUALITY,
    FRAME_AUDIENCE,
    FRAME_MODES,
    IMAGE_FORMATS,
)


class FramesContractTests(unittest.TestCase):
    def test_defaults_and_supported_values(self):
        self.assertEqual(FRAME_AUDIENCE, "video-frames")
        self.assertEqual(DEFAULT_IMAGE_FORMAT, "jpeg")
        self.assertEqual(DEFAULT_JPEG_QUALITY, 90)
        self.assertEqual(FRAME_MODES, ("fps", "every_n", "all"))
        self.assertEqual(IMAGE_FORMATS, ("jpeg", "png"))


if __name__ == "__main__":
    unittest.main()
