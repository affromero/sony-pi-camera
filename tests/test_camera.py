"""Exercise camera access and photo management through HTTP."""

import base64
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
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from PIL import Image

from camera import camera

SERVER = Path(__file__).resolve().parents[1] / "camera/camera.py"
SCHEDULE = SERVER.with_name("scheduled_capture.py")


class ApertureTest(unittest.TestCase):
    def test_setting_rejects_shutter_changes_in_aperture_priority(self):
        worker = mock.Mock()

        def usb(name, value, validate):
            validate(
                "Current: A\nEND\n"
                "Current: 1/200\nReadonly: 0\nChoice: 0 1/250\nEND\n"
            )
            return value

        worker.update_setting.side_effect = usb
        with mock.patch.object(camera, "RUST_PREVIEW", worker):
            with self.assertRaisesRegex(ValueError, "Setting is unavailable"):
                camera.set_setting("shutterspeed", "1/250")

    def test_region_uses_native_levels_and_reports_measured_center(self):
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
        output = (
            "Current: f/1.2\nReadonly: 0\n"
            "Choice: 0 f/1\nChoice: 1 f/1.2\n"
            "Choice: 2 f/16\nChoice: 3 f/22\n"
        )
        with mock.patch.object(camera, "command", return_value=output):
            self.assertEqual(
                camera.setting("f-number")["choices"], ["f/1.2", "f/16"]
            )

    def test_settings_snapshot_preserves_mode_limits_and_battery(self):
        blocks = {
            "expprogram": "Current: A",
            "iso": "Current: 64\nChoice: 0 25\nChoice: 1 64",
            "shutterspeed": "Current: 1/200\nChoice: 0 1/200",
            "batterylevel": "Current: 72%",
        }
        names = ("expprogram", *camera.SETTINGS, "batterylevel")
        output = "".join(
            blocks.get(name, "Current: Automatic") + "\nEND\n"
            for name in names
        )
        with mock.patch.object(camera, "command", return_value=output):
            data = camera.settings_snapshot()
        self.assertEqual(data["mode"], "A")
        self.assertEqual(data["battery"], "72%")
        self.assertEqual(data["iso"]["choices"], ["64"])
        self.assertTrue(data["shutterspeed"]["readonly"])


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
        fake_camera = cls.home / "sony-pi-preview"
        fake_camera.write_text(
            "#!/bin/sh\n"
            'case "$1" in\n'
            '"") while [ "$(dd bs=1 count=1 2>/dev/null)" = P ]; do '
            "printf '\\007\\000\\000\\000\\073\\000\\000\\000"
            "\\326\\000\\100\\001\\377\\330frame'; done;;\n"
            '--get-config) if [ "$2" = "expprogram" ]; then '
            'while [ "$#" -gt 0 ]; do '
            'case "$2" in '
            "expprogram) printf 'Current: M\\n';; "
            "iso) printf 'Current: 100\\nReadonly: 0\\nChoice: 0 400\\n';; "
            "*) printf 'Current: Auto\\n';; esac; "
            "printf 'END\\n'; shift 2; done; "
            'elif [ "$2" = "imagequality" ]; then '
            'printf "Current: %s\\n" "$(cat "$HOME/quality")"; '
            'else cat "$HOME/viewport"; fi;;\n'
            '--keep) touch "$HOME/shutter"; out="${4%.%C}"; '
            'while [ -e "$HOME/hold-shutter" ]; do sleep 0.02; done; '
            'cp "$HOME/original.jpg" "$out.jpg";;\n'
            "*) exit 1;;\nesac\n"
        )
        fake_camera.chmod(0o700)
        env["PI_CAMERA_BACKEND_BINARY"] = str(fake_camera)
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

    def test_schedule_requires_token_and_same_origin_to_write(self):
        for token, data, origin in (
            (None, None, None),
            (None, {}, self.base),
            (self.token, {}, None),
            (self.token, {}, "https://another.example"),
        ):
            with self.subTest(token=bool(token), origin=origin):
                with self.assertRaises(urllib.error.HTTPError) as error:
                    self.request("/api/schedule", token, data, origin)
                self.assertEqual(error.exception.code, 403)

    def test_preview_reports_the_camera_magnifier_viewport(self):
        with self.request("/api/preview", self.token) as response:
            self.assertEqual(response.read(), b"\xff\xd8frame")
            self.assertEqual(response.headers["X-Preview-Backend"], "rust")
            self.assertEqual(response.headers["X-Magnification"], "5.9")
            self.assertEqual(response.headers["X-Magnifier-X"], "0.5")
            self.assertEqual(response.headers["X-Magnifier-Y"], "0.5")

    def test_advice_input_requires_key_and_returns_preview_with_settings(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request("/api/advice-input")
        self.assertEqual(error.exception.code, 403)
        with self.request("/api/advice-input", self.token) as response:
            data = json.load(response)
        self.assertEqual(base64.b64decode(data["jpeg"]), b"\xff\xd8frame")
        self.assertEqual(data["magnification"], 5.9)
        self.assertEqual(data["settings"]["mode"], "M")
        self.assertEqual(data["settings"]["iso"]["choices"], ["400"])

    def test_timer_shoots_only_after_successful_advice_when_enabled(self):
        config = self.home / "ai.json"
        shutter = self.home / "shutter"
        (self.home / "viewport").write_text("Current: 0\nCurrent: 20971734")
        Image.new("RGB", (96, 64)).save(self.home / "original.jpg")
        runtime = self.home / "node"
        runtime.write_text(
            "#!/bin/sh\n"
            "cat > /dev/null\n"
            'if [ -e "$HOME/shutter" ]; then exit 1; fi\n'
            'if [ -e "$HOME/provider-fails" ]; then\n'
            "  printf '%s\\n' 'AI provider request failed.' >&2\n"
            "  exit 1\n"
            "fi\n"
            "printf '%s\\n' "
            """'{"assessment":"Raise ISO","suggestions":[]}'\n"""
        )
        runtime.chmod(0o700)
        env = os.environ.copy()
        env.update(
            HOME=str(self.home),
            PI_CAMERA_PORT=str(self.port),
            STATE_DIRECTORY=str(self.home),
        )
        env["PATH"] = str(self.home) + os.pathsep + env["PATH"]
        failure = self.home / "provider-fails"

        def run_timer():
            shutter.unlink(missing_ok=True)
            return subprocess.run(
                [sys.executable, str(SCHEDULE)],
                env=env,
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )

        try:
            ordinary = run_timer()
            self.assertEqual(ordinary.returncode, 0, ordinary.stderr)
            self.assertTrue(shutter.exists())
            self.assertNotIn("AI advice:", ordinary.stdout)

            config.write_text('{"enabled": true}')
            enabled = run_timer()
            self.assertEqual(enabled.returncode, 0, enabled.stderr)
            self.assertIn("Raise ISO", enabled.stdout)
            self.assertIn("Saved", enabled.stdout)
            self.assertTrue(shutter.exists())

            failure.touch()
            optional = run_timer()
            self.assertEqual(optional.returncode, 0, optional.stderr)
            self.assertIn("provider request failed", optional.stderr)
            self.assertTrue(shutter.exists())
            config.write_text('{"enabled": true, "requireAdvice": true}')
            failed = run_timer()
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn("provider request failed", failed.stderr)
            self.assertFalse(shutter.exists())
        finally:
            config.unlink(missing_ok=True)
            runtime.unlink(missing_ok=True)
            failure.unlink(missing_ok=True)

    def test_camera_refuses_competing_operations_during_capture(self):
        (self.home / "viewport").write_text("Current: 0\nCurrent: 20971734")
        Image.new("RGB", (96, 64)).save(self.home / "original.jpg")
        shutter = self.home / "shutter"
        shutter.unlink(missing_ok=True)
        hold = self.home / "hold-shutter"
        hold.touch()
        with ThreadPoolExecutor(max_workers=1) as pool:
            capture = pool.submit(
                self.request, "/api/capture", self.token, {}, self.base
            )
            try:
                for _ in range(100):
                    if shutter.exists():
                        break
                    time.sleep(0.02)
                self.assertTrue(shutter.exists())
                for path, data in [
                    ("/api/preview", None),
                    ("/api/settings", None),
                    ("/api/advice-input", None),
                    ("/api/focus", {"x": 0.5, "y": 0.5}),
                ]:
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        self.request(path, self.token, data, self.base)
                    with error.exception as response:
                        self.assertEqual(response.code, 409)
                        self.assertIn(
                            "Camera busy", json.load(response)["error"]
                        )
            finally:
                hold.unlink()
            with capture.result() as response:
                (name,) = json.load(response)["files"]
                (self.home / "camera-photos" / name).unlink()
        with self.request("/api/preview", self.token) as response:
            self.assertEqual(response.read(), b"\xff\xd8frame")

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

    def test_thumbnail_resizes_an_ordinary_jpeg_and_applies_orientation(self):
        path = self.home / "camera-photos" / "thumbnail-fixture.jpg"
        exif = Image.Exif()
        exif[274] = 6
        Image.new("RGB", (1600, 800), "red").save(path, exif=exif)
        self.addCleanup(path.unlink)
        with self.request(
            "/api/thumbnail/thumbnail-fixture.jpg", self.token
        ) as response:
            self.assertEqual(response.headers.get_content_type(), "image/jpeg")
            with Image.open(io.BytesIO(response.read())) as image:
                self.assertEqual(image.size, (128, 256))
                self.assertIsNone(image.getexif().get(274))

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

    def test_scheduled_job_saves_a_gallery_photo(self):
        (self.home / "viewport").write_text("Current: 0\nCurrent: 20971734")
        Image.new("RGB", (72, 48)).save(self.home / "original.jpg")
        job = subprocess.run(
            [sys.executable, str(SERVER.with_name("scheduled_capture.py"))],
            env=dict(
                os.environ, HOME=str(self.home), PI_CAMERA_PORT=str(self.port)
            ),
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        name = job.stdout.strip().removeprefix("Saved ")
        saved = self.home / "camera-photos" / name
        self.addCleanup(saved.unlink)
        with self.request("/api/photos", self.token) as response:
            self.assertIn(name, json.load(response))

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
            hidden = Path(folder) / ".private"
            hidden.mkdir()
            (hidden / "hidden.jpg").write_bytes(b"hidden")
            (Path(folder) / ".hidden.jpg").write_bytes(b"hidden")
            (Path(folder) / "alias.jpg").symlink_to(picture)
            (Path(folder) / "alias-dir").symlink_to(hidden)
            os.mkfifo(Path(folder) / "pipe")
            os.utime(picture, (100, 100))
            relative = picture.relative_to(self.home / "camera-photos")
            with self.request("/api/photos?details=1", self.token) as result:
                entries = json.load(result)
            self.assertEqual(entries[0]["name"], "example.jpg")
            self.assertEqual(
                entries[-1], {"name": str(relative), "saved": 100, "bytes": 8}
            )
            self.assertEqual(
                [
                    entry["name"]
                    for entry in entries
                    if entry["name"].startswith(
                        relative.parent.as_posix() + "/"
                    )
                ],
                [relative.as_posix()],
            )
            with self.request(f"/api/photos/{relative}", self.token) as result:
                self.assertEqual(result.read(), b"transfer")
