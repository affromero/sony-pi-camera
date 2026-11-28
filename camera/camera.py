#!/usr/bin/env python3
"""Private camera interface. Access through an SSH tunnel only."""

import atexit
import base64
import io
import json
import mimetypes
import os
import pwd
import re
import secrets
import socket
import ssl
import stat
import subprocess
import tempfile
import threading
import time
from collections.abc import Generator
from contextlib import contextmanager, nullcontext
from fractions import Fraction
from functools import lru_cache
from http.client import HTTPException
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import TYPE_CHECKING, cast
from urllib.parse import unquote, urlencode, urlsplit
from urllib.request import Request, urlopen

from PIL import Image, ImageOps
from PIL.MpoImagePlugin import MpoImageFile

if TYPE_CHECKING or __package__:
    from camera.rust_preview import RustPreview
else:
    from rust_preview import RustPreview

ROOT = Path(__file__).resolve().parent
PHOTOS = (Path.home() / "camera-photos").resolve()
TOKEN_FILE = Path.home() / ".config/sony-pi-camera/camera-token"
PORT = int(os.environ.get("PI_CAMERA_PORT", "8765"))
LAN_PORT = 8766
LOCK = threading.Lock()
CONTROL = threading.Lock()
THUMBNAILS = threading.BoundedSemaphore(2)
RUST_PREVIEW = None
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


class CameraBusy(Exception):
    """Another request owns or has reserved the camera."""


@contextmanager
def camera_read() -> Generator[None, None, None]:
    if CONTROL.locked() or not LOCK.acquire(blocking=False):
        raise CameraBusy("Camera busy. Waiting for the current operation.")
    try:
        yield
    finally:
        LOCK.release()


@contextmanager
def camera_control() -> Generator[None, None, None]:
    if not CONTROL.acquire(blocking=False):
        raise CameraBusy("Camera busy. Finish the current operation first.")
    try:
        with LOCK:
            yield
    finally:
        CONTROL.release()


def command(*args, cwd=None, timeout=90):
    if RUST_PREVIEW is None:
        raise RuntimeError("Rust camera backend has not been initialized")
    RUST_PREVIEW.stop()
    result = subprocess.run(
        [RUST_PREVIEW.executable, *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=timeout,
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
    return parse_setting(name, command("--get-config", name), mode)


def set_setting(name, value):
    if RUST_PREVIEW is None:
        raise RuntimeError("Rust camera backend has not been initialized")

    def validate(output):
        mode_config, setting_config, _ = output.split("\nEND\n")
        mode = parse_setting("expprogram", mode_config).get("current")
        current = parse_setting(name, setting_config, mode)
        if current.get("readonly") or value not in current["choices"]:
            raise ValueError("Setting is unavailable")

    return RUST_PREVIEW.update_setting(name, value, validate)


def parse_setting(name, output, mode=None):
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


def settings_snapshot(timeout=90):
    names = ("expprogram", *SETTINGS, "batterylevel")
    args = [arg for name in names for arg in ("--get-config", name)]
    blocks = command(*args, timeout=timeout).split("\nEND\n")
    if len(blocks) != len(names) + 1:
        raise RuntimeError("The camera returned an incomplete settings list.")
    mode = parse_setting("expprogram", blocks[0]).get("current", "Unavailable")
    values = {
        name: parse_setting(name, block, mode)
        for name, block in zip(SETTINGS, blocks[1:-2], strict=True)
    }
    values["mode"] = mode
    values["battery"] = parse_setting("batterylevel", blocks[-2]).get(
        "current", "Unavailable"
    )
    return values


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
    return viewport_from_raw(ratio, point)


def viewport_from_raw(ratio, point):
    return {
        "ratio": max(1, ratio / 10),
        "x": (point >> 16) / 640,
        "y": (point & 65535) / 428,
    }


def preview_frame(advice):
    if RUST_PREVIEW is None:
        raise RuntimeError("Rust camera backend has not been initialized")
    frame, ratio, point = RUST_PREVIEW.frame()
    settings = settings_snapshot(timeout=8) if advice else None
    return frame, viewport_from_raw(ratio, point), settings


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


def gallery_details(root):
    if not root.is_dir():
        return []
    entries = []
    for directory, children, names, fd in os.fwalk(
        root, follow_symlinks=False
    ):
        children[:] = [name for name in children if not name.startswith(".")]
        relative = os.path.relpath(directory, root)
        prefix = "" if relative == "." else relative + "/"
        for name in names:
            if name.startswith("."):
                continue
            try:
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            if stat.S_ISREG(info.st_mode):
                entries.append(
                    {
                        "name": prefix + name,
                        "saved": info.st_mtime,
                        "bytes": info.st_size,
                        "scheduled": bool(
                            re.fullmatch(
                                r"\d{8}-\d{6}-[0-9a-f]{8}-scheduled(?:-framed)?\.[A-Za-z0-9]+",
                                name,
                            )
                        ),
                    }
                )
    return sorted(entries, key=lambda entry: entry["saved"], reverse=True)


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


@contextmanager
def preserve_shutter_focus() -> Generator[None, None, None]:
    mode = setting("focusmode")["current"]
    if mode == "Manual":
        yield
        return
    try:
        set_setting("focusmode", "Manual")
        yield
    finally:
        set_setting("focusmode", mode)


def capture_photo(
    expected: dict | None, *, scheduled: bool = False
) -> list[str]:
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
    if scheduled:
        name += "-scheduled"
    with tempfile.TemporaryDirectory(prefix=".capture-", dir=PHOTOS) as tmp:
        directory = Path(tmp)
        # The Sony capture command half-presses the shutter before exposure.
        # For a shot from live view, keep the focus the operator chose.
        with (
            preserve_shutter_focus() if expected is not None else nullcontext()
        ):
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


def schedule_request(message: dict) -> dict:
    user = pwd.getpwuid(os.getuid()).pw_name
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(120)
        try:
            client.connect(f"/run/sony-pi-schedule-{user}.sock")
        except OSError as exc:
            raise RuntimeError(
                "The Pi schedule service is unavailable."
            ) from exc
        client.sendall(json.dumps(message).encode() + b"\n")
        with client.makefile("rb") as stream:
            response = json.loads(stream.readline(8192))
    if "error" in response:
        raise RuntimeError(response["error"])
    return response


@lru_cache(maxsize=8)
def fetch_tomorrow_forecast(
    key: tuple[float, float, str, str, int],
) -> dict:
    lat, lon, zone, date = key[:4]
    fields = (
        "weather_code",
        "temperature_2m_min",
        "temperature_2m_max",
        "precipitation_probability_max",
    )
    query = urlencode(
        dict(
            latitude=lat,
            longitude=lon,
            timezone=zone,
            daily=",".join(fields),
            start_date=date,
            end_date=date,
        )
    )
    with urlopen(
        "https://api.open-meteo.com/v1/forecast?" + query, timeout=5
    ) as response:
        day = json.loads(response.read(32_768))["daily"]
    index = day["time"].index(date)
    values = {key: day[key][index] for key in fields}
    if not all(type(value) in {int, float} for value in values.values()):
        raise ValueError("Incomplete forecast.")
    return {"date": date, **values}


def tomorrow_forecast(
    lat: float, lon: float, zone: str, date: str, cache_window: int
) -> dict | None:
    try:
        return fetch_tomorrow_forecast((lat, lon, zone, date, cache_window))
    except (
        HTTPException,
        OSError,
        ValueError,
        KeyError,
        IndexError,
        TypeError,
    ):
        return None


def jpeg_display_ranges(file: io.BufferedReader) -> list[tuple[int, int]]:
    size = os.fstat(file.fileno()).st_size
    with Image.open(file) as image:
        if not isinstance(image, MpoImageFile):
            return [(0, size)]
        if image.mpinfo is None:
            raise ValueError(
                "The camera's multi-picture JPEG has no frame index."
            )
        frame_end = image.mpinfo[0xB002][0]["Size"]
    # Remove the MP Index segment while preserving the first frame's JPEG data.
    file.seek(2)
    while file.tell() < min(frame_end, size):
        start = file.tell()
        header = file.read(4)
        if len(header) != 4 or header[0] != 0xFF or header[1] in (0xDA, 0xD9):
            break
        end = start + 2 + int.from_bytes(header[2:], "big")
        if not start + 4 <= end < frame_end <= size:
            break
        if (
            header[1] == 0xE2
            and end >= start + 8
            and file.read(4) == b"MPF\x00"
        ):
            file.seek(frame_end - 2)
            if file.read(2) == b"\xff\xd9":
                return [(0, start), (end, frame_end - end)]
            break
        file.seek(end)
    raise ValueError("The camera's multi-picture JPEG could not be displayed.")


def schedule_forecast(settings: dict) -> dict | None:
    location = settings.get("location")
    day = settings.get("tomorrowSun")
    if not location or not day:
        return None
    return tomorrow_forecast(
        round(location["latitude"], 2),
        round(location["longitude"], 2),
        settings["timezone"],
        day["date"],
        int(time.time() // 1800),
    )


def address_matches(data: object) -> list[dict]:
    query = data.get("query") if isinstance(data, dict) else None
    if not isinstance(query, str) or not 5 <= len(query.strip()) <= 160:
        raise ValueError("Enter an address of 5 to 160 characters.")
    url = "https://photon.komoot.io/api/?" + urlencode(
        {"q": query.strip(), "limit": 5}
    )
    try:
        request = Request(
            url,
            headers={
                "User-Agent": "SonyPiCamera (https://github.com/affromero/sony-pi-camera)"
            },
        )
        with urlopen(request, timeout=5) as response:
            features = json.loads(response.read(64_000))["features"]
        matches = []
        for item in features[:5]:
            lon, lat = item["geometry"]["coordinates"][:2]
            if not (
                type(lat) in {float, int}
                and type(lon) in {float, int}
                and -90 <= lat <= 90
                and -180 <= lon <= 180
            ):
                continue
            props = item["properties"]
            street = " ".join(
                str(props.get(key, "")) for key in ("housenumber", "street")
            ).strip()
            parts = [
                props.get("name"),
                street,
                props.get("city"),
                props.get("state"),
                props.get("postcode"),
                props.get("country"),
            ]
            label = ", ".join(
                dict.fromkeys(
                    value
                    for value in parts
                    if isinstance(value, str) and value
                )
            )
            if label:
                matches.append(
                    {"label": label, "latitude": lat, "longitude": lon}
                )
        return matches
    except (
        HTTPException,
        OSError,
        ValueError,
        KeyError,
        IndexError,
        TypeError,
    ):
        raise RuntimeError(
            "Address search is unavailable. Try again."
        ) from None


class CameraHTTPServer(ThreadingHTTPServer):
    def __init__(
        self,
        address: tuple[str, int],
        allowed_hosts: tuple[str, ...],
        scheme: str,
    ) -> None:
        self.allowed_hosts = allowed_hosts
        self.scheme = scheme
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    @property
    def camera_server(self) -> CameraHTTPServer:
        return cast(CameraHTTPServer, self.server)

    def send(
        self,
        body,
        content_type="application/json",
        status=200,
        headers=None,
        ranges=None,
    ):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        stream = isinstance(body, io.BufferedReader)
        sections = (
            ranges or [(0, os.fstat(body.fileno()).st_size)] if stream else []
        )
        length = sum(count for _, count in sections) if stream else len(body)
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; "
            + (
                "img-src 'self' blob: data:; worker-src blob:; "
                "connect-src 'self' https://tile.openstreetmap.org; "
                "script-src 'self' https://cdn.jsdelivr.net; "
                "style-src 'self' https://cdn.jsdelivr.net"
                if content_type == "text/html"
                else "img-src 'self' blob:"
            ),
        )
        if content_type == "text/html":
            self.send_header("Referrer-Policy", "strict-origin")
        self.end_headers()
        if stream:
            try:
                for offset, count in sections:
                    if count:
                        self.connection.sendfile(
                            body, offset=offset, count=count
                        )
            except OSError:
                self.close_connection = True
        else:
            self.wfile.write(body)

    def authorized(self):
        host = self.headers.get("Host", "")
        if host not in self.camera_server.allowed_hosts:
            return False
        origin = self.headers.get("Origin")
        if origin and origin != f"{self.camera_server.scheme}://{host}":
            return False
        return secrets.compare_digest(
            self.headers.get("X-Camera-Token", ""), TOKEN
        )

    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ("/", "/camera.js", "/camera.css"):
            if (
                self.headers.get("Host", "")
                not in self.camera_server.allowed_hosts
            ):
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
        advice = path == "/api/advice-input"
        if advice and self.camera_server.scheme != "http":
            self.send({"error": "Not found"}, status=404)
            return
        try:
            if path == "/api/preview" or advice:
                reservation = camera_control if advice else camera_read
                with reservation():
                    frame, state, settings = preview_frame(advice)
                if advice:
                    self.send(
                        {
                            "jpeg": base64.b64encode(frame).decode("ascii"),
                            "settings": settings,
                            "magnification": state["ratio"],
                        }
                    )
                    return
                self.send(
                    frame,
                    "image/jpeg",
                    headers={
                        "X-Preview-Backend": "rust",
                        "X-Magnification": str(state["ratio"]),
                        "X-Magnifier-X": str(state["x"]),
                        "X-Magnifier-Y": str(state["y"]),
                    },
                )
            elif path == "/api/schedule":
                self.send(schedule_request({"action": "read"}))
            elif path == "/api/schedule/forecast":
                settings = schedule_request({"action": "read"})
                self.send({"forecast": schedule_forecast(settings)})
            elif path == "/api/settings":
                with camera_read():
                    values = settings_snapshot()
                self.send(values)
            elif path == "/api/photos":
                if urlsplit(self.path).query == "details=1":
                    self.send(gallery_details(PHOTOS))
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
                with THUMBNAILS:
                    if item.suffix.lower() in (".jpg", ".jpeg"):
                        with Image.open(item) as image:
                            image.draft("RGB", (256, 256))
                            image.thumbnail((256, 256))
                            encoded = io.BytesIO()
                            ImageOps.exif_transpose(image).convert("RGB").save(
                                encoded, "JPEG"
                            )
                        thumbnail = encoded.getvalue()
                    else:
                        thumbnail = subprocess.run(
                            ["exiftool", "-b", "-ThumbnailImage", str(item)],
                            capture_output=True,
                            timeout=15,
                            check=True,
                        ).stdout
                if not thumbnail:
                    raise RuntimeError("No embedded thumbnail")
                self.send(thumbnail, "image/jpeg")
            elif path.startswith("/api/photos/"):
                item = photo(unquote(path[len("/api/photos/") :]))
                with item.open("rb") as original:
                    self.send(
                        original,
                        mimetypes.guess_type(item.name)[0]
                        or "application/octet-stream",
                        ranges=jpeg_display_ranges(original)
                        if urlsplit(self.path).query == "display=1"
                        and item.suffix.lower() in (".jpg", ".jpeg")
                        else None,
                    )
            else:
                self.send({"error": "Not found"}, status=404)
        except CameraBusy as exc:
            self.send({"error": str(exc)}, status=409)
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
            != f"{self.camera_server.scheme}://{self.headers.get('Host')}"
        ):
            self.send({"error": "Unauthorized"}, status=403)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 <= length <= 4096:
                raise ValueError("Request too large")
            data = json.loads(self.rfile.read(length) or b"{}")
            path = urlsplit(self.path).path
            if path == "/api/schedule":
                self.send(schedule_request({"update": data}))
            elif path == "/api/schedule/test":
                self.send(schedule_request({"action": "test"}), status=202)
            elif path == "/api/schedule/preview":
                self.send(schedule_request({"preview": data}))
            elif path == "/api/schedule/outlook":
                settings = schedule_request({"preview": data})
                self.send(
                    {**settings, "forecast": schedule_forecast(settings)}
                )
            elif path == "/api/schedule/address":
                self.send({"matches": address_matches(data)})
            elif path in ("/api/capture", "/api/capture/scheduled"):
                with camera_control():
                    files = capture_photo(
                        data.get("viewport"),
                        scheduled=path.endswith("/scheduled"),
                    )
                self.send({"ok": True, "files": files})
            elif path == "/api/magnifier":
                action = data.get("action")
                if action == "region":
                    with camera_control():
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
                with camera_control():
                    state = move_magnifier(*magnifier_steps(action))
                self.send({"ok": True, **state})
            elif path == "/api/focus":
                with camera_control():
                    result = focus_at(data["x"], data["y"])
                self.send(result)
            elif path == "/api/setting":
                name, value = data["name"], data["value"]
                if name not in SETTINGS or not isinstance(value, str):
                    raise ValueError("Invalid setting")
                with camera_control():
                    actual = set_setting(name, value)
                self.send({"ok": True, "current": actual})
            elif path == "/api/delete":
                photo(data["name"]).unlink()
                self.send({"ok": True})
            else:
                self.send({"error": "Not found"}, status=404)
        except CameraBusy as exc:
            self.send({"error": str(exc)}, status=409)
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
    backend_path = Path(
        os.getenv("PI_CAMERA_BACKEND_BINARY", ROOT / "sony-pi-preview")
    )
    RUST_PREVIEW = RustPreview(backend_path)
    atexit.register(RUST_PREVIEW.stop)
    PHOTOS.mkdir(mode=0o700, parents=True, exist_ok=True)
    TOKEN_FILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not TOKEN_FILE.exists():
        descriptor = os.open(
            TOKEN_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600
        )
        with os.fdopen(descriptor, "w") as stream:
            stream.write(secrets.token_urlsafe(32))
    TOKEN = TOKEN_FILE.read_text().strip()
    local = CameraHTTPServer(
        ("127.0.0.1", PORT),
        (f"localhost:{PORT}", f"127.0.0.1:{PORT}"),
        "http",
    )
    cert = TOKEN_FILE.parent / "camera.crt"
    key = TOKEN_FILE.parent / "camera.key"
    if os.environ.get("PI_CAMERA_REQUIRE_TLS") == "1" and not (
        cert.is_file() and key.is_file()
    ):
        raise RuntimeError("Camera TLS certificate or key is missing")
    if cert.exists() and key.exists():
        lan = CameraHTTPServer(
            ("0.0.0.0", LAN_PORT),
            (f"{socket.gethostname()}.local:{LAN_PORT}",),
            "https",
        )
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(cert, key)
        lan.socket = context.wrap_socket(lan.socket, server_side=True)
        threading.Thread(target=lan.serve_forever, daemon=True).start()
    local.serve_forever()
