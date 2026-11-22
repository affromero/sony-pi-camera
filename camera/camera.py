#!/usr/bin/env python3
"""Private camera interface. Access through an SSH tunnel only."""

import io
import json
import mimetypes
import os
import secrets
import socket
import ssl
import subprocess
import tempfile
import threading
import time
from fractions import Fraction
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent
PHOTOS = (Path.home() / "camera-photos").resolve()
TOKEN_FILE = Path.home() / ".config/sony-pi-camera/camera-token"
PORT = int(os.environ.get("PI_CAMERA_PORT", "8765"))
LAN_PORT = 8766
LOCK = threading.Lock()
SETTINGS = (
    "iso",
    "shutterspeed",
    "f-number",
    "whitebalance",
    "focusmode",
    "focusarea",
    "sensorcrop",
    "exposurecompensation",
    "imagequality",
)


def command(*args, cwd=None):
    result = subprocess.run(
        ["gphoto2", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=90,
        check=False,
    )
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout).strip()[-1000:])
    return result.stdout + result.stderr


def shutter_available(value, mode):
    if value.lower() == "bulb":
        return mode == "M"
    try:
        return Fraction(1, 8000) <= Fraction(value) <= 30
    except (ValueError, ZeroDivisionError):
        return False


def setting(name, mode=None):
    output = command("--get-config", name)
    result = {"choices": []}
    for line in output.splitlines():
        if line.startswith("Current: "):
            result["current"] = line[9:]
        elif line.startswith("Readonly: "):
            result["readonly"] = line[10:] != "0"
        elif line.startswith("Choice: "):
            _, value = line[8:].split(" ", 1)
            result["choices"].append(value)
    if name == "iso":
        result["choices"] = [
            v
            for v in result["choices"]
            if v == "Auto ISO" or (v.isdecimal() and 50 <= int(v) <= 204800)
        ]
    elif name == "shutterspeed":
        result["choices"] = [
            v for v in result["choices"] if shutter_available(v, mode)
        ]
        if mode not in {"M", "S"}:
            result["readonly"] = True
    elif name == "sensorcrop":
        # This body reports its crop state but ignores USB writes to it.
        result["readonly"] = True
    elif name == "f-number":
        # The installed Sigma 35mm F1.2 DG DN Art supports f/1.2 to f/16.
        # gPhoto instead reports a generic f/1 to f/64 range.
        result["choices"] = [
            value
            for value in result["choices"]
            if value.startswith("f/") and 1.2 <= float(value[2:]) <= 16
        ]
    return result


def focus_at(x, y):
    if any(type(v) not in (int, float) or not 0 <= v <= 1 for v in (x, y)):
        raise ValueError("Choose a point within the preview.")
    if setting("focusmode")["current"] == "Manual":
        raise ValueError("Set the lens switch and camera to autofocus.")
    if "Flexible Spot" not in setting("focusarea")["current"]:
        raise ValueError("Select Flexible Spot in the Focus area menu.")
    # ILCE-7M3 uses the legacy packed position, on a 640 x 428 grid.
    target = (round(x * 639) << 16) | round(y * 427)
    command("--set-config-value", f"d232={target}")
    time.sleep(0.25)
    position = int(setting("d232")["current"])
    try:
        output = command(
            "--set-config-value",
            "autofocus=1",
            "--wait-event=2s",
            "--get-config",
            "d213",
            "--set-config-value",
            "autofocus=0",
        )
    except (RuntimeError, subprocess.TimeoutExpired):
        command("--set-config-value", "autofocus=0")
        raise
    return {
        "x": (position >> 16) / 639,
        "y": (position & 65535) / 427,
        "locked": any(
            line in ("Current: 2", "Current: 6")
            for line in output.splitlines()
        ),
    }


def viewport(output):
    ratio, point = [
        int(line[9:])
        for line in output.splitlines()
        if line.startswith("Current: ")
    ]
    return {
        "ratio": max(1, ratio / 10),
        "x": (point >> 16) / 640,
        "y": (point & 65535) / 428,
    }


def magnifier_steps(action, count=1):
    key = "focusmagnify" + action
    return (
        "--set-config-value",
        key + "=1",
        "--set-config-value",
        key + "=0",
    ) * count


def move_magnifier(*buttons):
    command(*buttons)
    # The camera acknowledges button events before updating these properties.
    time.sleep(0.35)
    return viewport(command("--get-config", "d22f", "--get-config", "d230"))


def magnify_region(x, y, width, height):
    if any(
        type(v) not in (int, float) or not 0 <= v <= 1
        for v in (x, y, width, height)
    ):
        raise ValueError("Choose a region within the preview.")
    state = move_magnifier(*magnifier_steps("exit"))
    if state["ratio"] != 1:
        raise RuntimeError("The camera could not return to the full frame.")
    for _ in range(2):
        state = move_magnifier(*magnifier_steps(""))
        if state["ratio"] > 1:
            break
    else:
        raise RuntimeError(
            "The camera could not activate its focus magnifier."
        )
    # A tap selects the first level. The second native level is about twice
    # the first; use the level closest to the box on a logarithmic scale.
    size = max(width, height)
    if size and size * state["ratio"] * 2**0.5 < 1:
        previous = state["ratio"]
        state = move_magnifier(*magnifier_steps(""))
        if state["ratio"] <= previous:
            raise RuntimeError("The camera could not increase magnification.")
    margin = 0.5 / state["ratio"]
    target_x = max(margin, min(1 - margin, x))
    target_y = max(margin, min(1 - margin, y))
    # Each press moves roughly three units on the 640 x 428 grid. Batch
    # presses in one USB session and correct against the actual readback.
    for attempt in range(5):
        dx = round((target_x - state["x"]) * 640 / 3)
        dy = round((target_y - state["y"]) * 428 / 3)
        if abs(dx) <= 1 and abs(dy) <= 1:
            return state
        if attempt == 4:
            break
        before = state
        state = move_magnifier(
            *magnifier_steps("right" if dx > 0 else "left", abs(dx)),
            *magnifier_steps("down" if dy > 0 else "up", abs(dy)),
        )
        if state["ratio"] != before["ratio"]:
            raise RuntimeError("The camera left the selected magnification.")
        if state == before:
            break
    raise RuntimeError(
        "The camera could not reach that region. "
        "Choose a region closer to the center."
    )


def photo(name):
    if not name or any(
        not part or part.startswith(".") for part in name.split("/")
    ):
        raise ValueError("Invalid filename")
    path = PHOTOS / name
    if path.resolve() != path or not path.is_file():
        raise FileNotFoundError("Photo not found")
    return path


def save_framed_jpeg(source: Path, target: Path, state: dict) -> None:
    with Image.open(source) as image:
        # Sony may package the main JPEG and a secondary image as an MPO.
        if image.format not in ("JPEG", "MPO"):
            raise ValueError("The camera did not deliver a JPEG.")
        width, height = image.size
        w = max(1, round(width / state["ratio"]))
        h = max(1, round(height / state["ratio"]))
        x = max(0, min(width - w, round(state["x"] * width - w / 2)))
        y = max(0, min(height - h, round(state["y"] * height - h / 2)))
        # Sony's USB coordinates follow the sensor. Apply EXIF rotation
        # after cropping to avoid rotating a full-size image in Pi memory.
        cropped = image.crop((x, y, x + w, y + h))
        framed = ImageOps.exif_transpose(cropped)
        exif = image.getexif()
        output_exif = Image.Exif()
        for tag in (271, 272, 306):  # Make, model and timestamp.
            if tag in exif:
                output_exif[tag] = exif[tag]
        exposure = exif.get_ifd(34665)
        keep = (33434, 33437, 34855, 36867, 36868, 37386, 42036)
        if exposure:
            output_exif[34665] = {
                k: exposure[k] for k in keep if k in exposure
            }
        framed.save(
            target,
            "JPEG",
            quality=96,
            subsampling=0,
            exif=output_exif,
            icc_profile=image.info.get("icc_profile"),
        )


def capture_photo(expected: dict | None) -> list[str]:
    state = viewport(command("--get-config", "d22f", "--get-config", "d230"))
    if expected is not None and (
        not isinstance(expected, dict)
        or any(type(expected.get(k)) not in (float, int) for k in state)
        or any(expected[k] != state[k] for k in state)
    ):
        raise ValueError("Framing changed. Check the live view and try again.")
    framed = state["ratio"] > 1
    if (
        framed
        and setting("imagequality").get("current", "").strip().upper() == "RAW"
    ):
        raise ValueError("Select JPEG or RAW + JPEG for a magnified capture.")
    name = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(4)
    with tempfile.TemporaryDirectory(prefix=".capture-", dir=PHOTOS) as tmp:
        directory = Path(tmp)
        output = command(
            "--keep",
            "--capture-image-and-download",
            "--filename",
            str(directory / (name + ".%C")),
            cwd=directory,
        )
        files = sorted(directory.glob(name + ".*"))
        if not files:
            raise RuntimeError(
                "The camera did not deliver a photo. " + output.strip()[-500:]
            )
        if framed:
            jpeg = next(
                (p for p in files if p.suffix.lower() in (".jpg", ".jpeg")),
                None,
            )
            if jpeg is None:
                raise RuntimeError(
                    "The camera did not deliver a JPEG for this crop. "
                    "Check the PC Remote RAW+J transfer setting."
                )
            target = directory / (name + "-framed.jpg")
            save_framed_jpeg(jpeg, target, state)
            files = [target]
        for path in files:
            path.replace(PHOTOS / path.name)
        return [p.name for p in files]


class Handler(BaseHTTPRequestHandler):
    def send(
        self, body, content_type="application/json", status=200, headers=None
    ):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' blob:; "
            "frame-ancestors 'none'; base-uri 'none'",
        )
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        host = self.headers.get("Host", "")
        if host not in self.server.allowed_hosts:
            return False
        origin = self.headers.get("Origin")
        if origin and origin != f"{self.server.scheme}://{host}":
            return False
        return secrets.compare_digest(
            self.headers.get("X-Camera-Token", ""), TOKEN
        )

    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ("/", "/camera.js", "/camera.css"):
            if self.headers.get("Host", "") not in self.server.allowed_hosts:
                self.send(b"Forbidden", "text/plain", 403)
                return
            name = "camera.html" if path == "/" else path[1:]
            self.send(
                (ROOT / name).read_bytes(), mimetypes.guess_type(name)[0]
            )
            return
        if not self.authorized():
            self.send({"error": "Unauthorized"}, status=403)
            return
        try:
            if path == "/api/preview":
                with LOCK, tempfile.TemporaryDirectory() as directory:
                    output = command(
                        "--capture-preview",
                        "--filename",
                        "preview.jpg",
                        "--get-config",
                        "d22f",
                        "--get-config",
                        "d230",
                        cwd=directory,
                    )
                    images = list(Path(directory).glob("*.jpg"))
                    if not images:
                        raise RuntimeError("Camera returned no preview")
                    state = viewport(output)
                    self.send(
                        images[0].read_bytes(),
                        "image/jpeg",
                        headers={
                            "X-Magnification": str(state["ratio"]),
                            "X-Magnifier-X": str(state["x"]),
                            "X-Magnifier-Y": str(state["y"]),
                        },
                    )
            elif path == "/api/settings":
                with LOCK:
                    mode = setting("expprogram").get("current", "Unavailable")
                    values = {name: setting(name, mode) for name in SETTINGS}
                    values["battery"] = setting("batterylevel").get(
                        "current", "Unavailable"
                    )
                    values["mode"] = mode
                self.send(values)
            elif path == "/api/photos":
                if urlsplit(self.path).query == "details=1":
                    entries = []
                    for item in PHOTOS.rglob("*"):
                        name = item.relative_to(PHOTOS).as_posix()
                        if item.is_dir() or any(
                            part.startswith(".") for part in name.split("/")
                        ):
                            continue
                        try:
                            stat = photo(name).stat()
                        except FileNotFoundError:
                            continue
                        entries.append(
                            {
                                "name": name,
                                "saved": stat.st_mtime,
                                "bytes": stat.st_size,
                            }
                        )
                    self.send(
                        sorted(entries, key=lambda p: p["saved"], reverse=True)
                    )
                    return
                self.send(
                    sorted(
                        (
                            p.name
                            for p in PHOTOS.iterdir()
                            if p.is_file() and not p.is_symlink()
                        ),
                        reverse=True,
                    )
                )
            elif path.startswith("/api/thumbnail/"):
                item = photo(unquote(path[len("/api/thumbnail/") :]))
                if item.name.endswith("-framed.jpg"):
                    with Image.open(item) as image:
                        image.thumbnail((256, 256))
                        encoded = io.BytesIO()
                        image.save(encoded, "JPEG")
                    self.send(encoded.getvalue(), "image/jpeg")
                    return
                result = subprocess.run(
                    ["exiftool", "-b", "-ThumbnailImage", str(item)],
                    capture_output=True,
                    timeout=15,
                    check=True,
                )
                if not result.stdout:
                    raise RuntimeError("No embedded thumbnail")
                self.send(result.stdout, "image/jpeg")
            elif path.startswith("/api/photos/"):
                item = photo(unquote(path[len("/api/photos/") :]))
                self.send(
                    item.read_bytes(),
                    mimetypes.guess_type(item.name)[0]
                    or "application/octet-stream",
                )
            else:
                self.send({"error": "Not found"}, status=404)
        except (
            OSError,
            ValueError,
            RuntimeError,
            subprocess.CalledProcessError,
            subprocess.TimeoutExpired,
        ) as exc:
            self.send({"error": str(exc)}, status=503)

    def do_POST(self):
        if (
            not self.authorized()
            or self.headers.get("Origin")
            != f"{self.server.scheme}://{self.headers.get('Host')}"
        ):
            self.send({"error": "Unauthorized"}, status=403)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 4096:
                raise ValueError("Request too large")
            data = json.loads(self.rfile.read(length) or b"{}")
            path = urlsplit(self.path).path
            if path == "/api/capture":
                with LOCK:
                    files = capture_photo(data.get("viewport"))
                self.send({"ok": True, "files": files})
            elif path == "/api/magnifier":
                action = data.get("action")
                if action == "region":
                    with LOCK:
                        state = magnify_region(
                            data.get("x"),
                            data.get("y"),
                            data.get("width"),
                            data.get("height"),
                        )
                    self.send(state)
                    return
                if action not in ("", "exit", "left", "right", "up", "down"):
                    raise ValueError("Unknown magnifier action")
                with LOCK:
                    state = move_magnifier(*magnifier_steps(action))
                self.send({"ok": True, **state})
            elif path == "/api/focus":
                with LOCK:
                    result = focus_at(data["x"], data["y"])
                self.send(result)
            elif path == "/api/setting":
                name, value = data["name"], data["value"]
                if name not in SETTINGS or not isinstance(value, str):
                    raise ValueError("Invalid setting")
                with LOCK:
                    mode = setting("expprogram").get("current")
                    current = setting(name, mode)
                    if (
                        current.get("readonly")
                        or value not in current["choices"]
                    ):
                        raise ValueError("Setting is unavailable")
                    command("--set-config-value", f"{name}={value}")
                    actual = setting(name).get("current")
                    if actual != value:
                        raise RuntimeError(
                            f"Camera reports {actual} after requesting {value}"
                        )
                self.send({"ok": True})
            elif path == "/api/delete":
                photo(data["name"]).unlink()
                self.send({"ok": True})
            else:
                self.send({"error": "Not found"}, status=404)
        except (
            OSError,
            ValueError,
            KeyError,
            RuntimeError,
            subprocess.TimeoutExpired,
        ) as exc:
            self.send({"error": str(exc)}, status=503)

    def log_message(self, format, *args):
        return


if __name__ == "__main__":
    PHOTOS.mkdir(mode=0o700, parents=True, exist_ok=True)
    TOKEN_FILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not TOKEN_FILE.exists():
        descriptor = os.open(
            TOKEN_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600
        )
        with os.fdopen(descriptor, "w") as stream:
            stream.write(secrets.token_urlsafe(32))
    TOKEN = TOKEN_FILE.read_text().strip()
    local = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    local.allowed_hosts = (f"localhost:{PORT}", f"127.0.0.1:{PORT}")
    local.scheme = "http"
    cert = TOKEN_FILE.parent / "camera.crt"
    key = TOKEN_FILE.parent / "camera.key"
    if os.environ.get("PI_CAMERA_REQUIRE_TLS") == "1" and not (
        cert.is_file() and key.is_file()
    ):
        raise RuntimeError("Camera TLS certificate or key is missing")
    if cert.exists() and key.exists():
        lan = ThreadingHTTPServer(("0.0.0.0", LAN_PORT), Handler)
        lan.allowed_hosts = (f"{socket.gethostname()}.local:{LAN_PORT}",)
        lan.scheme = "https"
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(cert, key)
        lan.socket = context.wrap_socket(lan.socket, server_side=True)
        threading.Thread(target=lan.serve_forever, daemon=True).start()
    local.serve_forever()
