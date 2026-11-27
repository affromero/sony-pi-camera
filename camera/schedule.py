"""Manage one user's daily capture timer through a private systemd socket."""

import json
import os
import pwd
import re
import socket
import subprocess
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

TIME = r"(?:[01][0-9]|2[0-3]):[0-5][0-9]"
MANAGED = "zz-sony-dashboard.conf"
HEADER = "# Managed by Sony Pi Camera\n"
EMPTY = "# Camera schedule cleared. Time zone: "
UNIT_DIR = Path("/etc/systemd/system")


def timezone(value: object) -> str:
    if not isinstance(value, str) or not re.fullmatch(
        r"[A-Za-z][A-Za-z0-9_+/-]{0,99}", value
    ):
        raise ValueError("Choose an IANA timezone such as America/Chicago.")
    try:
        ZoneInfo(value)
    except (ValueError, ZoneInfoNotFoundError) as exc:
        raise ValueError("Unknown timezone.") from exc
    return value


def validate(data: object) -> dict:
    if not isinstance(data, dict) or set(data) != {
        "enabled",
        "times",
        "timezone",
    }:
        raise ValueError("Expected enabled, times, and timezone.")
    times = data["times"]
    if type(data["enabled"]) is not bool:
        raise ValueError("Enabled must be true or false.")
    if (
        not isinstance(times, list)
        or len(times) > 24
        or (data["enabled"] and not times)
        or not all(isinstance(t, str) and re.fullmatch(TIME, t) for t in times)
        or len(set(times)) != len(times)
    ):
        raise ValueError(
            "Choose up to 24 distinct times, with at least one when enabled."
        )
    return dict(
        enabled=data["enabled"],
        times=sorted(times),
        timezone=timezone(data["timezone"]),
    )


def ctl(*args: str) -> str:
    result = subprocess.run(
        ["/usr/bin/systemctl", *args],
        capture_output=True,
        text=True,
        timeout=20,
        env={**os.environ, "LC_ALL": "C", "TZ": "UTC"},
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "Systemd command failed.")
    return result.stdout.strip()


def pi_timezone() -> str:
    result = subprocess.run(
        ["/usr/bin/timedatectl", "show", "-p", "Timezone", "--value"],
        capture_output=True,
        text=True,
        timeout=5,
        check=True,
    )
    return timezone(result.stdout.strip())


def daily_times(unit_text: str) -> tuple[list[str], str, bool]:
    section = ""
    calendar: list[str] = []
    cleared_zone = None
    for line in unit_text.splitlines():
        line = line.strip()
        if line.startswith("["):
            section = line
        if section == "[Timer]" and line.startswith(EMPTY):
            cleared_zone = timezone(line.removeprefix(EMPTY))
        if section != "[Timer]" or line.startswith(("#", ";")):
            continue
        key, equals, value = line.partition("=")
        if not equals:
            continue
        key = key.strip()
        if key == "OnCalendar":
            if value.strip():
                calendar.append(value.strip())
            else:
                calendar.clear()
        elif key not in {"AccuracySec", "Persistent"}:
            raise RuntimeError(f"Timer uses administrator setting {key}.")
    times = []
    zones = set()
    inherits_timezone = True
    for entry in calendar:
        match = re.fullmatch(rf"\*-\*-\* ({TIME})(?::00)?(?: (\S+))?", entry)
        if not match:
            raise RuntimeError("Timer uses a custom calendar expression.")
        times.append(match[1])
        zones.add(match[2] or pi_timezone())
        inherits_timezone = inherits_timezone and match[2] is None
    if len(zones) != 1:
        raise RuntimeError("Timer needs daily times in one timezone.")
    if cleared_zone:
        return [], cleared_zone, False
    return times, zones.pop(), inherits_timezone


def state(unit: str) -> dict:
    properties = dict(
        line.split("=", 1)
        for line in ctl(
            "show", "-p", "ActiveState,UnitFileState,NeedDaemonReload", unit
        ).splitlines()
    )
    enabled = properties["UnitFileState"]
    if properties["NeedDaemonReload"] != "no" or (
        enabled,
        properties["ActiveState"],
    ) not in {("enabled", "active"), ("disabled", "inactive")}:
        raise RuntimeError("Timer state requires administrator attention.")
    times, zone, _ = daily_times(ctl("cat", unit))
    return validate(
        dict(enabled=enabled == "enabled", times=times, timezone=zone)
    )


def replace(path: Path, content: str) -> None:
    with tempfile.NamedTemporaryFile(
        dir=path.parent, delete=False, mode="w"
    ) as file:
        temp = Path(file.name)
        try:
            file.write(content)
            file.flush()
            os.fchmod(file.fileno(), 0o644)
            temp.replace(path)
        finally:
            temp.unlink(missing_ok=True)


def schedule_response(unit: str, settings: dict) -> dict:
    next_capture_at = None
    inherits_timezone = False
    if settings["enabled"]:
        stamp = ctl("show", "-p", "NextElapseUSecRealtime", "--value", unit)
        if stamp and stamp != "n/a":
            date_and_time = stamp.split()[1:3]
            stamp_utc = datetime.fromisoformat(" ".join(date_and_time))
            next_capture_at = int(stamp_utc.replace(tzinfo=UTC).timestamp())
    else:
        _, _, inherits_timezone = daily_times(ctl("cat", unit))
    return {
        **settings,
        "nextCaptureAt": next_capture_at,
        "inheritsTimezone": inherits_timezone,
    }


def update(unit: str, data: object) -> dict:
    requested = validate(data)
    previous = state(unit)
    if previous == requested:
        return previous
    path = UNIT_DIR / (unit + ".d") / MANAGED
    old = path.read_text() if path.exists() else None
    if old is not None and not old.startswith(HEADER):
        raise RuntimeError("Schedule drop-in belongs to the administrator.")
    content = (
        HEADER
        + "[Timer]\nOnCalendar=\n"
        + "".join(
            f"OnCalendar=*-*-* {t}:00 {requested['timezone']}\n"
            for t in requested["times"]
        )
    )
    if not requested["times"]:
        # systemd requires at least one trigger in a valid timer unit.
        # Keep the stock trigger inert and record the cleared schedule.
        content = (
            HEADER
            + "[Unit]\nConditionPathExists=!/\n"
            + "[Timer]\n"
            + EMPTY
            + requested["timezone"]
            + "\n"
        )
    path.parent.mkdir(mode=0o755, exist_ok=True)
    try:
        if not requested["enabled"]:
            ctl("disable", "--now", unit)
        replace(path, content)
        ctl("daemon-reload")
        if daily_times(ctl("cat", unit))[:2] != (
            requested["times"],
            requested["timezone"],
        ):
            raise RuntimeError("An administrator override takes precedence.")
        if requested["enabled"]:
            ctl("enable", unit)
            ctl("restart", unit)
        actual = state(unit)
        if actual != requested:
            raise RuntimeError("Systemd did not apply the requested schedule.")
        return actual
    except Exception:
        if old is None:
            path.unlink(missing_ok=True)
        else:
            replace(path, old)
        ctl("daemon-reload")
        if previous["enabled"]:
            ctl("enable", unit)
            ctl("restart", unit)
        else:
            ctl("disable", "--now", unit)
        raise


def serve(user: str) -> None:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*", user):
        raise ValueError("Unsupported camera username.")
    pwd.getpwnam(user)
    unit = f"sony-pi-capture@{user}.timer"
    with socket.socket(fileno=3) as listener:
        while True:
            conn, _ = listener.accept()
            with conn:
                conn.settimeout(3)
                try:
                    with conn.makefile("rb") as stream:
                        line = stream.readline(8193)
                    if len(line) > 8192 or not line.endswith(b"\n"):
                        raise ValueError("Invalid schedule request.")
                    msg = json.loads(line)
                    if msg == {"action": "read"}:
                        response = schedule_response(unit, state(unit))
                    elif msg == {"action": "test"}:
                        capture = unit.removesuffix(".timer") + ".service"
                        ctl("start", "--no-block", capture)
                        response = {"queued": True}
                    elif isinstance(msg, dict) and set(msg) == {"update"}:
                        response = schedule_response(
                            unit, update(unit, msg["update"])
                        )
                    else:
                        raise ValueError("Invalid schedule request.")
                except (
                    OSError,
                    ValueError,
                    RuntimeError,
                    subprocess.SubprocessError,
                ) as exc:
                    response = {"error": str(exc)}
                try:
                    conn.sendall(json.dumps(response).encode() + b"\n")
                except OSError:
                    pass


if __name__ == "__main__":
    serve(sys.argv[1])
