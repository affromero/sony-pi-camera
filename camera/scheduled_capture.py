"""Trigger one photo through the local dashboard's camera lock."""

import json
import os
import subprocess
import sys
import time
from http.client import HTTPConnection
from pathlib import Path

MAX_ADVICE_INPUT = 3 * 1024 * 1024


def advice_input(port: int, token: str) -> bytes:
    connection = HTTPConnection("127.0.0.1", port, timeout=20)
    try:
        connection.request(
            "GET", "/api/advice-input", headers={"X-Camera-Token": token}
        )
        response = connection.getresponse()
        if response.status != 200:
            raise RuntimeError(
                f"AI preview unavailable (camera HTTP {response.status})"
            )
        payload = response.read(MAX_ADVICE_INPUT + 1)
        if len(payload) > MAX_ADVICE_INPUT:
            raise RuntimeError("AI preview and settings exceed the size limit")
        return payload
    finally:
        connection.close()


def log_advice(port: int, token: str, state_dir: Path) -> None:
    script = Path(__file__).resolve().parent / "sidedoor/advice.mjs"
    result = subprocess.run(
        ["node", str(script), str(state_dir)],
        input=advice_input(port, token),
        capture_output=True,
        timeout=28,
        check=False,
    )
    if result.returncode:
        message = result.stderr.decode(errors="replace").strip()
        if message not in {
            "AI configuration or credential is invalid.",
            "AI camera snapshot is invalid.",
            "AI provider request failed.",
            "AI provider returned invalid advice.",
        }:
            message = (
                "AI advisor could not start. Check Node and dependencies."
            )
        raise RuntimeError(message)
    advice = json.loads(result.stdout)
    if advice is not None:
        print("AI advice:", json.dumps(advice), flush=True)


def capture(port: int, token: str) -> list[str]:
    for attempt in range(13):
        connection = HTTPConnection("127.0.0.1", port, timeout=240)
        try:
            connection.request(
                "POST",
                "/api/capture",
                body=b"{}",
                headers={
                    "Content-Type": "application/json",
                    "Origin": f"http://127.0.0.1:{port}",
                    "X-Camera-Token": token,
                },
            )
            response = connection.getresponse()
            result = json.loads(response.read())
            if response.status == 200 and result.get("files"):
                return result["files"]
            if response.status != 409:
                raise RuntimeError(result.get("error", "Capture failed"))
        finally:
            connection.close()
        if attempt < 12:
            time.sleep(5)
    raise RuntimeError("The camera was busy for one minute")


def run(config_dir: Path, port: int, state_dir: Path | None) -> list[str]:
    token = (config_dir / "camera-token").read_text().strip()
    if state_dir is not None:
        try:
            state = (state_dir / "ai.json").read_text()
        except FileNotFoundError:
            pass
        else:
            settings = json.loads(state)
            enabled = (
                settings.get("enabled") if isinstance(settings, dict) else None
            )
            if type(enabled) is not bool:
                raise RuntimeError("Saved AI configuration is invalid")
            if enabled:
                required = settings.get("requireAdvice", False)
                if type(required) is not bool:
                    raise RuntimeError("Saved AI policy is invalid")
                try:
                    log_advice(port, token, state_dir)
                except (
                    OSError,
                    ValueError,
                    RuntimeError,
                    subprocess.TimeoutExpired,
                ) as exc:
                    message = (
                        "AI advisor timed out"
                        if isinstance(exc, subprocess.TimeoutExpired)
                        else str(exc)
                    )
                    if required:
                        raise RuntimeError(message) from exc
                    print(
                        f"AI advice unavailable: {message}. Capturing.",
                        file=sys.stderr,
                        flush=True,
                    )
    return capture(port, token)


if __name__ == "__main__":
    try:
        state_dir = os.getenv("STATE_DIRECTORY")
        files = run(
            Path.home() / ".config/sony-pi-camera",
            int(os.getenv("PI_CAMERA_PORT", "8765")),
            Path(state_dir) if state_dir else None,
        )
        print("Saved", ", ".join(files))
    except subprocess.TimeoutExpired:
        sys.exit("AI advisor timed out")
    except (OSError, ValueError, RuntimeError) as exc:
        sys.exit(str(exc))
