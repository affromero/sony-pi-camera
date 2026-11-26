"""Exercise the settings a camera operator can read and save."""

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from camera import schedule

ROOT = Path(__file__).resolve().parents[1] / "camera"
UNIT = "sony-pi-capture@operator.timer"


class ScheduleTest(unittest.TestCase):
    def test_rejects_invalid_times_and_unit_directive_injection(self):
        data = dict(enabled=False, times=["12:30"], timezone="UTC")
        for change in (
            {"times": []},
            {"times": ["24:10"]},
            {"times": ["12:30"] * 2},
            {"times": ["12:30\nOnBootSec=5s"]},
            {"timezone": "UTC\n[Install]"},
            {"timezone": "Unknown/Place"},
            {"enabled": 1},
            {"unit": "another.timer"},
        ):
            with self.subTest(change=change), self.assertRaises(ValueError):
                schedule.validate(data | change)

    def test_settings_persist_and_failed_updates_restore_admin_schedule(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / (UNIT + ".d")
            folder.mkdir()
            admin = folder / "override.conf"
            original = "[Timer]\nOnCalendar=\nOnCalendar=*-*-* 18:00:00 UTC\n"
            admin.write_text(original)
            enabled = False
            fail_enable = False

            def systemctl(*args):
                nonlocal enabled
                if args[0] == "cat":
                    return (ROOT / "sony-pi-capture@.timer").read_text() + (
                        "".join(
                            p.read_text()
                            for p in sorted(folder.glob("*.conf"))
                        )
                    )
                if args[0] == "show":
                    file_state, active = (
                        ("enabled", "active")
                        if enabled
                        else ("disabled", "inactive")
                    )
                    return (
                        f"UnitFileState={file_state}\nActiveState={active}\n"
                        "NeedDaemonReload=no"
                    )
                if args[0] == "enable" and fail_enable:
                    raise RuntimeError("Enable failed")
                if args[0] in {"enable", "disable"}:
                    enabled = args[0] == "enable"
                return ""

            with (
                mock.patch.object(schedule, "UNIT_DIR", root),
                mock.patch.object(schedule, "ctl", side_effect=systemctl),
            ):
                self.assertEqual(schedule.state(UNIT)["times"], ["18:00"])
                saved = dict(
                    enabled=False,
                    times=["09:00", "19:00"],
                    timezone="America/Chicago",
                )
                self.assertEqual(schedule.update(UNIT, saved), saved)
                fail_enable = True
                with self.assertRaisesRegex(RuntimeError, "Enable failed"):
                    schedule.update(
                        UNIT, saved | {"enabled": True, "times": ["15:30"]}
                    )
                self.assertEqual(schedule.state(UNIT), saved)
                self.assertEqual(admin.read_text(), original)

    def test_custom_calendars_require_an_administrator(self):
        for value in ("Mon 12:00", "*-*-* 12:30:20 UTC"):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                schedule.daily_times("[Timer]\nOnCalendar=" + value)

    def test_reports_the_running_timers_next_capture(self):
        settings = dict(enabled=True, times=["08:00", "12:30"], timezone="UTC")
        with mock.patch.object(
            schedule, "ctl", return_value="Thu 1970-01-01 12:30:00 UTC"
        ):
            self.assertEqual(
                schedule.schedule_response(UNIT, settings)["nextCaptureAt"],
                45000,
            )

    def test_distinguishes_inherited_and_explicit_timezones(self):
        with mock.patch.object(
            schedule, "pi_timezone", return_value="Europe/London"
        ):
            self.assertTrue(
                schedule.daily_times("[Timer]\nOnCalendar=*-*-* 12:30")[2]
            )
            self.assertFalse(
                schedule.daily_times("[Timer]\nOnCalendar=*-*-* 12:30 UTC")[2]
            )
