"""Processing tests for UC4 using a generated short video."""

from fractions import Fraction
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile

from use_cases.frames import (
    build_single_frame_command,
    create_frames_zip,
    process_frames,
)
from use_cases.frames_domain import plan_frames
from utils.common import VideoInfo, VideoError


class FramesProcessingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.root = Path(cls.directory.name)
        cls.source = cls.root / "source.mp4"
        subprocess.run(
            [
                "ffmpeg", "-v", "error", "-f", "lavfi",
                "-i", "testsrc=size=96x64:rate=4:duration=1",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", str(cls.source),
            ],
            check=True,
        )
        cls.info = VideoInfo(1, 96, 64, Fraction(4), "mp4", False)

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def test_command_uses_single_timestamp_and_jpeg_quality(self):
        command = build_single_frame_command(
            self.source, self.root / "frame.jpg", 0.5, "jpeg", 90
        )
        self.assertIn("-ss", command)
        self.assertIn("0.500000", command)
        self.assertEqual(command[command.index("-q:v") + 1], "4")

    def test_processes_frames_and_creates_ordered_zip(self):
        plan = plan_frames(
            {"mode": "fps", "fps": 2, "endSeconds": 1},
            self.info,
            "free",
            first_frame_bytes=100,
        )
        destination = self.root / "result.zip"
        result = process_frames(self.source, destination, plan, self.info)
        self.assertEqual(result["frameCount"], 3)
        self.assertEqual(len(result["preview"]), 3)
        with zipfile.ZipFile(destination) as archive:
            names = archive.namelist()
            self.assertEqual(names, sorted(names))
            self.assertEqual(names, result["preview"])
            self.assertTrue(all(name.endswith(".jpg") for name in names))

    def test_zip_size_limit_removes_partial_output(self):
        plan = plan_frames(
            {"mode": "fps", "fps": 1, "endSeconds": 1},
            self.info,
            "free",
            first_frame_bytes=1,
        )
        plan = plan.__class__(
            **{**plan.__dict__, "limits": plan.limits.__class__(300, 1)}
        )
        frame = self.root / "frame.jpg"
        frame.write_bytes(b"not-an-image")
        with self.assertRaisesRegex(VideoError, "exceeds"):
            create_frames_zip(
                [frame], self.root / "too-large.zip", plan
            )
        self.assertFalse((self.root / "too-large.zip").exists())


if __name__ == "__main__":
    unittest.main()
