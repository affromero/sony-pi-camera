"""Exercise camera access and photo management through HTTP."""

import importlib.util
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

from PIL import Image

SERVER = Path(__file__).resolve().parents[1] / "camera/camera.py"


class ApertureTest(unittest.TestCase):
    def test_region_uses_native_levels_and_reports_measured_center(self):
        spec = importlib.util.spec_from_file_location("camera", SERVER)
        camera = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(camera)
        ratio, x, y = 0, 320, 214

        def usb(*args):
            nonlocal ratio, x, y
            if args[0] == "--get-config":
                return f"Current: {ratio}\nCurrent: {(x << 16) | y}"
            for press in args[1::4]:
                if press == "focusmagnifyexit=1":
                    ratio, x, y = 0, 320, 214
                elif press == "focusmagnify=1":
                    ratio = 59 if ratio == 0 else 117
                else:
                    dx, dy = {
                        "focusmagnifyright=1": (3, 0),
                        "focusmagnifyleft=1": (-3, 0),
                        "focusmagnifyup=1": (0, -3),
                        "focusmagnifydown=1": (0, 3),
                    }[press]
                    x, y = x + dx, y + dy
            return ""

        with (
            mock.patch.object(camera, "command", side_effect=usb),
            mock.patch.object(camera.time, "sleep"),
        ):
            for size, level in [(0, 5.9), (0.2, 5.9), (0.05, 11.7)]:
                with self.subTest(size=size):
                    state = camera.magnify_region(0.84, 0.37, size, size)
                    self.assertEqual(state["ratio"], level)
                    self.assertAlmostEqual(state["x"], 0.84, delta=0.008)
                    self.assertAlmostEqual(state["y"], 0.37, delta=0.012)
            state = camera.magnify_region(0, 1, 0, 0)
            self.assertAlmostEqual(state["x"], 0.5 / 5.9, delta=0.008)
            self.assertAlmostEqual(state["y"], 1 - 0.5 / 5.9, delta=0.012)
            with self.assertRaises(ValueError):
                camera.magnify_region(0.5, 0.5, float("nan"), 0.2)

    def test_focus_reports_camera_selected_point_and_lock(self):
        spec = importlib.util.spec_from_file_location("camera", SERVER)
        camera = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(camera)

        def device(*args):
            if args[0] == "--get-config":
                value = {
                    "d232": (80 << 16) | 64,
                    "focusmode": "Automatic",
                    "focusarea": "Flexible Spot: M",
                }[args[1]]
                return f"Current: {value}"
            return "Current: 2" if "d213" in args else ""

        with mock.patch.object(camera, "command", side_effect=device):
            result = camera.focus_at(0, 0)
            self.assertEqual(
                result, {"x": 80 / 639, "y": 64 / 427, "locked": True}
            )
            with self.assertRaises(ValueError):
                camera.focus_at(1.1, 0)

    def test_still_exposure_choices_respect_body_and_mode(self):
        spec = importlib.util.spec_from_file_location("camera", SERVER)
        camera = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(camera)
        iso = ["Auto ISO", "25", "50", "64", "204800", "409600"]
        speeds = ["30", "32/10", "1/8000", "1/32000", "Bulb"]
        for name, choices, expected in [
            ("iso", iso, ["Auto ISO", "50", "64", "204800"]),
            ("shutterspeed", speeds, ["30", "32/10", "1/8000", "Bulb"]),
        ]:
            output = "\n".join(
                f"Choice: {i} {v}" for i, v in enumerate(choices)
            )
            with mock.patch.object(camera, "command", return_value=output):
                self.assertEqual(
                    camera.setting(name, "M")["choices"], expected
                )
                if name == "shutterspeed":
                    self.assertTrue(camera.setting(name, "A")["readonly"])
                    self.assertNotIn(
                        "Bulb", camera.setting(name, "S")["choices"]
                    )

    def test_aperture_choices_match_the_installed_lens(self):
        spec = importlib.util.spec_from_file_location("camera", SERVER)
        camera = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(camera)
        output = (
            "Current: f/1.2\nReadonly: 0\n"
            "Choice: 0 f/1\nChoice: 1 f/1.2\n"
            "Choice: 2 f/16\nChoice: 3 f/22\n"
        )
        with mock.patch.object(camera, "command", return_value=output):
            self.assertEqual(
                camera.setting("f-number")["choices"], ["f/1.2", "f/16"]
            )


class CameraTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.home = Path(cls.tmp.name)
        photos = cls.home / "camera-photos"
        photos.mkdir()
        (photos / "example.jpg").write_bytes(b"photo")
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            cls.port = listener.getsockname()[1]
        cls.base = f"http://127.0.0.1:{cls.port}"
        env = os.environ.copy()
        env.update(HOME=str(cls.home), PI_CAMERA_PORT=str(cls.port))
        fake_camera = cls.home / "gphoto2"
        fake_camera.write_text(
            "#!/bin/sh\n"
            'case "$1" in\n'
            "--capture-preview) printf frame > preview.jpg; "
            "printf 'Current: 59\\nCurrent: 20971734\\n';;\n"
            '--get-config) if [ "$2" = "imagequality" ]; then '
            'printf "Current: %s\\n" "$(cat "$HOME/quality")"; '
            'else cat "$HOME/viewport"; fi;;\n'
            '--keep) touch "$HOME/shutter"; out="${4%.%C}"; '
            'cp "$HOME/original.jpg" "$out.jpg";;\n'
            "*) exit 1;;\nesac\n"
        )
        fake_camera.chmod(0o700)
        env["PATH"] = str(cls.home) + os.pathsep + env["PATH"]
        cls.process = subprocess.Popen([sys.executable, str(SERVER)], env=env)
        token_file = cls.home / ".config/sony-pi-camera/camera-token"
        for _ in range(100):
            if token_file.exists() and token_file.read_text():
                cls.token = token_file.read_text()
                break
            time.sleep(0.05)
        else:
            raise RuntimeError("Camera service did not start")

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        cls.process.wait(timeout=5)
        cls.tmp.cleanup()

    def request(self, path, token=None, data=None, origin=None):
        headers = {}
        if token is not None:
            headers["X-Camera-Token"] = token
        if origin is not None:
            headers["Origin"] = origin
        body = None if data is None else json.dumps(data).encode()
        return urllib.request.urlopen(
            urllib.request.Request(self.base + path, body, headers), timeout=5
        )

    def setUp(self):
        (self.home / "camera-photos/example.jpg").write_bytes(b"photo")

    def test_photos_require_token_and_can_be_downloaded(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request("/api/photos")
        self.assertEqual(error.exception.code, 403)
        with self.request("/api/photos", self.token) as response:
            self.assertEqual(json.load(response), ["example.jpg"])
        with self.request("/api/photos/example.jpg", self.token) as response:
            self.assertEqual(response.read(), b"photo")

    def test_preview_reports_the_camera_magnifier_viewport(self):
        with self.request("/api/preview", self.token) as response:
            self.assertEqual(response.read(), b"frame")
            self.assertEqual(response.headers["X-Magnification"], "5.9")
            self.assertEqual(response.headers["X-Magnifier-X"], "0.5")
            self.assertEqual(response.headers["X-Magnifier-Y"], "0.5")

    def test_capture_saves_magnified_sensor_region_with_orientation(self):
        viewport = {"ratio": 5.9, "x": 0.75, "y": 0.25}
        (self.home / "viewport").write_text(
            f"Current: 59\nCurrent: {(480 << 16) | 107}\n"
        )
        (self.home / "quality").write_text("Extra Fine")
        original = Image.new("RGB", (320, 200), "red")
        original.paste((0, 250, 0), (208, 30, 271, 70))
        exif = Image.Exif()
        exif[274] = 6
        original.save(
            self.home / "original.jpg",
            format="MPO",
            save_all=True,
            append_images=[Image.new("RGB", (80, 50), "blue")],
            exif=exif,
        )
        with self.request(
            "/api/capture", self.token, {"viewport": viewport}, self.base
        ) as response:
            (name,) = json.load(response)["files"]
        self.addCleanup((self.home / "camera-photos" / name).unlink)
        for prefix in ("/api/photos/", "/api/thumbnail/"):
            with self.request(prefix + name, self.token) as response:
                with Image.open(io.BytesIO(response.read())) as saved:
                    self.assertEqual(saved.size, (34, 54))
                    r, g, b = saved.getpixel((0, 0))
                    self.assertGreater(g, max(r, b) + 150)

    def test_capture_rejects_stale_frame_and_raw_only_before_shutter(self):
        (self.home / "shutter").unlink(missing_ok=True)
        (self.home / "viewport").write_text("Current: 59\nCurrent: 20971734")
        (self.home / "quality").write_text("RAW")
        for ratio, message in [(1, "Framing changed"), (5.9, "Select JPEG")]:
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.request(
                    "/api/capture",
                    self.token,
                    {"viewport": {"ratio": ratio, "x": 0.5, "y": 0.5}},
                    self.base,
                )
            self.assertIn(message, json.load(error.exception)["error"])
            self.assertFalse((self.home / "shutter").exists())

    def test_full_frame_capture_retains_camera_file(self):
        (self.home / "viewport").write_text("Current: 0\nCurrent: 20971734")
        original = self.home / "original.jpg"
        Image.new("RGB", (96, 64), "blue").save(original)
        with self.request("/api/capture", self.token, {}, self.base) as resp:
            (name,) = json.load(resp)["files"]
        saved = self.home / "camera-photos" / name
        self.addCleanup(saved.unlink)
        self.assertEqual(saved.read_bytes(), original.read_bytes())

    def test_delete_requires_same_origin_and_deletes_selected_photo(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request(
                "/api/delete",
                self.token,
                {"name": "example.jpg"},
                "http://evil.example",
            )
        self.assertEqual(error.exception.code, 403)
        self.assertTrue((self.home / "camera-photos/example.jpg").exists())
        with self.request(
            "/api/delete", self.token, {"name": "example.jpg"}, self.base
        ) as response:
            self.assertTrue(json.load(response)["ok"])
        self.assertFalse((self.home / "camera-photos/example.jpg").exists())

    def test_gallery_lists_transferred_photos_by_saved_time(self):
        with tempfile.TemporaryDirectory(
            dir=self.home / "camera-photos"
        ) as folder:
            picture = Path(folder) / "card.jpg"
            picture.write_bytes(b"transfer")
            os.utime(picture, (100, 100))
            relative = picture.relative_to(self.home / "camera-photos")
            with self.request("/api/photos?details=1", self.token) as result:
                entries = json.load(result)
            self.assertEqual(entries[0]["name"], "example.jpg")
            self.assertEqual(
                entries[-1], {"name": str(relative), "saved": 100, "bytes": 8}
            )
            with self.request(f"/api/photos/{relative}", self.token) as result:
                self.assertEqual(result.read(), b"transfer")
