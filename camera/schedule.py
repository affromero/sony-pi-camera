"""Manage one user's daily capture timer through a private systemd socket."""

import json
import os
import pwd
import re
import socket
import subprocess
import sys
import tempfile
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from astral import Observer
from astral.sun import sunrise, sunset

TIME = r"(?:[01][0-9]|2[0-3]):[0-5][0-9]"
MANAGED = "zz-sony-dashboard.conf"
HEADER = "# Managed by Sony Pi Camera\n"
EMPTY = "# Camera schedule cleared. Time zone: "
SOLAR = "# Sony Pi Camera solar rules: "
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
    required = {"enabled", "times", "timezone"}
    if (
        not isinstance(data, dict)
        or not required <= set(data)
        or (set(data) - required - {"solar", "location"})
    ):
        raise ValueError("Expected enabled, times, and timezone.")
    times = data["times"]
    rules = data.get("solar", [])
    if type(data["enabled"]) is not bool:
        raise ValueError("Enabled must be true or false.")
    if (
        not isinstance(times, list)
        or not isinstance(rules, list)
        or len(times) + len(rules) > 24
        or (data["enabled"] and not (times or rules))
        or not all(isinstance(t, str) and re.fullmatch(TIME, t) for t in times)
        or len(set(times)) != len(times)
    ):
        raise ValueError(
            "Choose up to 24 distinct times, with at least one when enabled."
        )
    config = dict(
        enabled=data["enabled"],
        times=sorted(times),
        timezone=timezone(data["timezone"]),
    )
    location = data.get("location")
    if location is not None:
        if (
            not isinstance(location, dict)
            or set(location) != {"latitude", "longitude"}
            or not all(
                type(location[key]) in {float, int}
                and -limit <= location[key] <= limit
                for key, limit in (("latitude", 90), ("longitude", 180))
            )
        ):
            raise ValueError("Enter valid camera latitude and longitude.")
        config["location"] = location
    if rules:
        if location is None:
            raise ValueError("Set the camera location for sunrise or sunset.")
        for rule in rules:
            if (
                not isinstance(rule, dict)
                or set(rule) != {"event", "offset"}
                or rule["event"] not in ("sunrise", "sunset")
                or type(rule["offset"]) is not int
                or not -720 <= rule["offset"] <= 720
            ):
                raise ValueError("Choose a solar offset of up to 720 minutes.")
        if len({(rule["event"], rule["offset"]) for rule in rules}) != len(
            rules
        ):
            raise ValueError("Choose distinct sunrise and sunset rules.")
        config["solar"] = rules
    return config


def solar_occurrences(settings: dict, now: datetime) -> list[list[datetime]]:
    rules = settings.get("solar", [])
    if not rules:
        return []
    observer = Observer(**settings["location"])
    zone = ZoneInfo(settings["timezone"])
    today = now.astimezone(zone).date()
    result = []
    for rule in rules:
        event = sunrise if rule["event"] == "sunrise" else sunset
        dates = []
        for delta in range(-1, 9):
            try:
                at = event(observer, today + timedelta(days=delta), zone)
            except ValueError:
                continue
            at = at.astimezone(UTC).replace(microsecond=0) + timedelta(
                minutes=rule["offset"]
            )
            if at > now:
                dates.append(at)
        result.append(dates)
    return result


def calendar_hash(entries: list[str]) -> str:
    return sha256("\n".join(entries).encode()).hexdigest()


def saved_rules(unit_text: str, *, armed: bool) -> dict | None:
    for line in unit_text.splitlines():
        if line.startswith(SOLAR):
            data = json.loads(line.removeprefix(SOLAR))
            entries, cleared_zone = timer_calendar(unit_text)
            expected = data["calendarHash"]
            if data["armed"] != armed or (
                calendar_hash(entries) != expected
                if expected
                else not cleared_zone
            ):
                raise RuntimeError(
                    "The capture timer changed outside the camera dashboard."
                )
            return validate(data["settings"])
    return None


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


def timer_calendar(unit_text: str) -> tuple[list[str], str | None]:
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
    return calendar, cleared_zone


def daily_times(unit_text: str) -> tuple[list[str], str, bool]:
    calendar, cleared_zone = timer_calendar(unit_text)
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
    body = ctl("cat", unit)
    rules = saved_rules(body, armed=enabled == "enabled")
    if rules is not None:
        if not rules["enabled"] and enabled == "enabled":
            raise RuntimeError("The disabled schedule has an active timer.")
        return rules
    times, zone, _ = daily_times(body)
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
            os.fchmod(file.fileno(), 0o600 if SOLAR in content else 0o644)
            temp.replace(path)
        finally:
            temp.unlink(missing_ok=True)


def tomorrow_sun(settings: dict, now: datetime) -> dict | None:
    if not settings.get("location"):
        return None
    zone = ZoneInfo(settings["timezone"])
    day = now.astimezone(zone).date() + timedelta(days=1)
    observer = Observer(**settings["location"])
    result: dict[str, str | int | None] = {"date": day.isoformat()}
    for event in (sunrise, sunset):
        try:
            result[event.__name__] = int(
                event(observer, day, zone).timestamp()
            )
        except ValueError:
            result[event.__name__] = None
    return result


def schedule_response(unit: str, settings: dict) -> dict:
    next_capture_at = None
    inherits_timezone = False
    if settings["enabled"]:
        stamp = ctl("show", "-p", "NextElapseUSecRealtime", "--value", unit)
        if stamp and stamp != "n/a":
            date_and_time = stamp.split()[1:3]
            stamp_utc = datetime.fromisoformat(" ".join(date_and_time))
            next_capture_at = int(stamp_utc.replace(tzinfo=UTC).timestamp())
    elif not settings.get("solar") and not settings.get("location"):
        _, _, inherits_timezone = daily_times(ctl("cat", unit))
    now = datetime.now(UTC)
    return {
        **settings,
        "nextCaptureAt": next_capture_at,
        "inheritsTimezone": inherits_timezone,
        "tomorrowSun": tomorrow_sun(settings, now),
        "solarNext": [
            int(dates[0].timestamp()) if dates else None
            for dates in solar_occurrences(settings, now)
        ],
    }


def update(unit: str, data: object, *, refresh: bool = False) -> dict:
    requested = validate(data)
    previous = state(unit)
    if previous == requested and not refresh:
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
    dates = sorted(
        {
            at
            for rule in solar_occurrences(requested, datetime.now(UTC))
            for at in rule
        }
    )
    if not requested["times"] and not dates:
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
    if dates:
        content += "".join(
            f"OnCalendar={at:%Y-%m-%d %H:%M:%S} UTC\n" for at in dates
        )
    armed = requested["enabled"] and bool(requested["times"] or dates)
    if requested.get("solar") or requested.get("location"):
        entries, cleared_zone = timer_calendar(content)
        record = {
            "settings": requested,
            "armed": armed,
            "calendarHash": None if cleared_zone else calendar_hash(entries),
        }
        content += SOLAR + json.dumps(record, separators=(",", ":")) + "\n"
    path.parent.mkdir(mode=0o755, exist_ok=True)
    was_armed = (
        ctl("show", "-p", "UnitFileState", "--value", unit) == "enabled"
    )
    try:
        if not armed:
            ctl("disable", "--now", unit)
        replace(path, content)
        ctl("daemon-reload")
        effective = ctl("cat", unit)
        if requested.get("solar") and (requested["times"] or dates):
            expected, _ = timer_calendar(content)
            actual_calendar, _ = timer_calendar(effective)
            matches = expected == actual_calendar
        else:
            matches = daily_times(effective)[:2] == (
                requested["times"],
                requested["timezone"],
            )
        if not matches:
            raise RuntimeError("An administrator override takes precedence.")
        if armed:
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
        if was_armed:
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
                    elif msg == {"action": "refresh"}:
                        current = state(unit)
                        if current["enabled"] and current.get("solar"):
                            update(unit, current, refresh=True)
                        response = {"ok": True}
                    elif isinstance(msg, dict) and set(msg) == {"preview"}:
                        settings = validate(msg["preview"])
                        response = {
                            "solarNext": [
                                int(dates[0].timestamp()) if dates else None
                                for dates in solar_occurrences(
                                    settings, datetime.now(UTC)
                                )
                            ]
                        }
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


def refresh_schedule(user: str) -> None:
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(120)
        client.connect(f"/run/sony-pi-schedule-{user}.sock")
        client.sendall(b'{"action":"refresh"}\n')
        with client.makefile("rb") as stream:
            result = json.loads(stream.readline(8192))
        if not result.get("ok"):
            raise RuntimeError(result.get("error", "Schedule refresh failed."))


if __name__ == "__main__":
    if sys.argv[1] == "--refresh":
        refresh_schedule(sys.argv[2])
    else:
        serve(sys.argv[1])
