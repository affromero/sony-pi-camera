"""Compare the CLI and Rust USB preview paths without taking a still."""

import argparse
import io
import json
import platform
import statistics
import subprocess
import time
from collections import Counter
from pathlib import Path

from PIL import Image

from camera import camera
from camera.rust_preview import RustPreview


def check_camera_service() -> None:
    if not Path("/run/systemd/system").is_dir():
        return
    result = subprocess.run(
        [
            "systemctl",
            "list-units",
            "--no-legend",
            "--no-pager",
            "--state=active,activating,deactivating,reloading",
            "sony-pi-camera@*.service",
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=5,
    )
    if result.stdout.strip():
        raise RuntimeError("Stop the active Sony Pi Camera service first.")


def measure(frames: int) -> dict[str, object]:
    timings = []
    dimensions: Counter[str] = Counter()
    repeats = 0
    previous = None
    sequence_start = time.monotonic()
    for _ in range(frames):
        start = time.monotonic()
        jpeg, _, _ = camera.preview_frame(False)
        timings.append((time.monotonic() - start) * 1000)
        with Image.open(io.BytesIO(jpeg)) as image:
            dimensions[f"{image.width}x{image.height}"] += 1
        repeats += jpeg == previous
        previous = jpeg
    elapsed = time.monotonic() - sequence_start
    warm = sorted(timings[1:])
    return {
        "frames": frames,
        "dimensions": dict(dimensions),
        "first_ms": round(timings[0], 3),
        "subsequent_median_ms": round(statistics.median(warm), 3),
        "subsequent_p95_ms": round(warm[(95 * len(warm) - 1) // 100], 3),
        "wall_frames_per_second": round(frames / elapsed, 3),
        "adjacent_identical_jpegs": repeats,
    }


def compare(worker: RustPreview, frames: int) -> dict[str, object]:
    versions = [
        line.strip()
        for line in camera.command("--version", timeout=5).splitlines()
        if line.startswith(("gphoto2 ", "libgphoto2 ", "libgphoto2_port "))
    ]
    cli = measure(frames)
    camera.RUST_PREVIEW = worker
    try:
        rust = measure(frames)
        start = time.monotonic()
        settings = camera.viewport(
            camera.command("--get-config", "d22f", "--get-config", "d230")
        )
        handoff_ms = (time.monotonic() - start) * 1000
        start = time.monotonic()
        camera.preview_frame(False)
        reopen_ms = (time.monotonic() - start) * 1000
    finally:
        worker.stop()
        camera.RUST_PREVIEW = None
    return {
        "architecture": platform.machine(),
        "gphoto_versions": versions,
        "cli": cli,
        "rust": rust,
        "handoff": {
            "cli_viewport_read_ms": round(handoff_ms, 3),
            "rust_reopen_and_preview_ms": round(reopen_ms, 3),
            "viewport": settings,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--worker", type=Path, default=Path("/opt/pi-camera/sony-pi-preview")
    )
    parser.add_argument("--frames", type=int, default=60)
    args = parser.parse_args()
    if not 3 <= args.frames <= 200:
        parser.error("--frames must be between 3 and 200")
    try:
        check_camera_service()
        result = compare(RustPreview(args.worker.resolve()), args.frames)
        print(json.dumps(result, indent=2))
    except (
        OSError,
        RuntimeError,
        ValueError,
        subprocess.SubprocessError,
    ) as exc:
        parser.exit(1, f"Preview comparison failed: {exc}\n")


if __name__ == "__main__":
    main()
