"""Exercise the camera's optional native worker at the process boundary."""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from camera import camera
from camera.rust_preview import RustPreview


class RustPreviewTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def start_worker(self, source):
        binary = self.root / "preview"
        binary.write_text(
            f"#!{sys.executable}\n"
            "import struct, sys\n"
            "from pathlib import Path\n"
            f"receipt = Path({str(self.root / 'released')!r})\n"
            f"{source}"
        )
        binary.chmod(0o700)
        worker = RustPreview(binary, timeout=0.5)
        self.addCleanup(worker.stop)
        return worker

    def test_reuses_preview_session_and_releases_it_before_cli(self):
        worker = self.start_worker(
            "sequence = 0\n"
            "while sys.stdin.buffer.read(1) == b'P':\n"
            "    sequence += 1\n"
            "    jpeg = bytes((255, 216, sequence, 0))\n"
            "    sys.stdout.buffer.write(struct.pack('<III', 4, 59, sequence)"
            " + jpeg)\n"
            "    sys.stdout.flush()\n"
            "receipt.touch()\n"
        )
        with mock.patch.object(camera, "RUST_PREVIEW", worker):
            frame, state, _ = camera.preview_frame(False)
            self.assertEqual(frame, b"\xff\xd8\x01\x00")
            self.assertEqual(state["y"], 1 / 428)
            frame, state, _ = camera.preview_frame(False)
            self.assertEqual(frame, b"\xff\xd8\x02\x00")
            self.assertEqual(state["y"], 2 / 428)

            def cli(argv, **options):
                self.assertTrue((self.root / "released").exists())
                return subprocess.CompletedProcess(argv, 0, "Current: 100", "")

            with mock.patch.object(subprocess, "run", side_effect=cli):
                self.assertEqual(
                    camera.command("--get-config", "iso"), "Current: 100"
                )
            self.assertEqual(worker.frame()[0], b"\xff\xd8\x01\x00")

    def test_releases_usb_after_a_partial_reply_times_out(self):
        worker = self.start_worker(
            "sys.stdin.buffer.read(1)\n"
            "sys.stdout.buffer.write(b'partial')\n"
            "sys.stdout.flush()\n"
            "sys.stdin.buffer.read()\n"
            "receipt.touch()\n"
        )
        with self.assertRaises(TimeoutError):
            worker.frame()
        self.assertTrue((self.root / "released").exists())

    def test_refuses_oversized_reply_and_releases_usb(self):
        worker = self.start_worker(
            "sys.stdin.buffer.read(1)\n"
            "sys.stdout.buffer.write(struct.pack('<III', 9_000_000, 0, 0))\n"
            "sys.stdout.flush()\n"
            "sys.stdin.buffer.read()\n"
            "receipt.touch()\n"
        )
        with self.assertRaisesRegex(RuntimeError, "preview size"):
            worker.frame()
        self.assertTrue((self.root / "released").exists())
