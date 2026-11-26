"""Run on an ephemeral Linux runner after a fresh camera service install."""

import json
import os
import subprocess
import time
from datetime import UTC, datetime, timedelta
from http.client import HTTPConnection
from pathlib import Path


def request(token: str, schedule: dict | None = None) -> dict:
    http = HTTPConnection("127.0.0.1", 8765, timeout=15)
    try:
        http.request(
            "GET" if schedule is None else "POST",
            "/api/schedule",
            None if schedule is None else json.dumps(schedule),
            headers={
                "Origin": "http://127.0.0.1:8765",
                "Content-Type": "application/json",
                "X-Camera-Token": token,
            },
        )
        response = http.getresponse()
        result = json.loads(response.read())
        if response.status != 200:
            raise RuntimeError(f"HTTP {response.status}: {result}")
        return result
    finally:
        http.close()


def main() -> None:
    if os.getenv("RUNNER_ENVIRONMENT") != "github-hosted":
        raise SystemExit("This check requires a disposable GitHub runner.")
    key = Path.home() / ".config/sony-pi-camera/camera-token"
    for _ in range(50):
        try:
            original = request(key.read_text().strip())
            break
        except (FileNotFoundError, ConnectionRefusedError):
            time.sleep(0.2)
    else:
        raise RuntimeError("The test dashboard did not start.")
    assert original["enabled"] is False
    token = key.read_text().strip()
    later = datetime.now(UTC) + timedelta(hours=6)
    times = [later.strftime("%H:%M")]
    schedule = {"enabled": True, "times": times, "timezone": "UTC"}
    unit = f"sony-pi-capture@{os.environ['USER']}.timer"
    try:
        request(token, schedule)
        current = request(token)
        assert all(current[k] == v for k, v in schedule.items()), current
        assert current["nextCaptureAt"] > 0, current
        subprocess.run(["systemctl", "is-active", "--quiet", unit], check=True)
        subprocess.run(
            ["systemctl", "is-enabled", "--quiet", unit], check=True
        )
    finally:
        request(token, {**schedule, "enabled": False})
    assert request(token)["enabled"] is False
    assert subprocess.run(
        ["systemctl", "is-active", "--quiet", unit]
    ).returncode


if __name__ == "__main__":
    main()
