"""Trigger one photo through the local dashboard's camera lock."""

import json
import os
import sys
import time
from http.client import HTTPConnection
from pathlib import Path


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


if __name__ == "__main__":
    try:
        key = Path.home() / ".config/sony-pi-camera/camera-token"
        files = capture(
            int(os.getenv("PI_CAMERA_PORT", "8765")), key.read_text().strip()
        )
        print("Saved", ", ".join(files))
    except (OSError, ValueError, RuntimeError) as exc:
        sys.exit(str(exc))
