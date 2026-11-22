"""Pipe transport for the native USB preview worker."""

import os
import selectors
import struct
import subprocess
import time
from pathlib import Path

HEADER = struct.Struct("<III")
MAX_FRAME_BYTES = 2 * 1024 * 1024


class RustPreview:
    def __init__(self, executable: Path, timeout: float = 10) -> None:
        if not executable.is_absolute() or not (
            executable.is_file() and os.access(executable, os.X_OK)
        ):
            raise ValueError(
                f"Rust camera backend requires an executable at {executable}"
            )
        self.executable = executable
        self.timeout = timeout
        self.process: subprocess.Popen[bytes] | None = None

    def stop(self) -> None:
        process = self.process
        if process is None:
            return
        assert process.stdin is not None and process.stdout is not None
        process.stdin.close()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)
            raise RuntimeError("Rust preview did not release USB gracefully")
        finally:
            if process.poll() is not None:
                process.stdout.close()
                self.process = None

    def frame(self) -> tuple[bytes, int, int]:
        if self.process is None:
            self.process = subprocess.Popen(
                [self.executable],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                bufsize=0,
            )
        process = self.process
        assert process.stdin is not None and process.stdout is not None
        deadline = time.monotonic() + self.timeout
        try:
            process.stdin.write(b"P")
            fd = process.stdout.fileno()
            with selectors.DefaultSelector() as selector:
                selector.register(fd, selectors.EVENT_READ)

                def read_exact(size: int) -> bytes:
                    received = bytearray()
                    while len(received) < size:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0 or not selector.select(remaining):
                            raise TimeoutError("Rust preview timed out")
                        chunk = os.read(fd, size - len(received))
                        if not chunk:
                            raise RuntimeError("Rust preview worker exited")
                        received.extend(chunk)
                    return bytes(received)

                size, ratio, point = HEADER.unpack(read_exact(HEADER.size))
                if not 4 <= size <= MAX_FRAME_BYTES:
                    raise RuntimeError("Invalid Rust preview size")
                jpeg = read_exact(size)
                if not jpeg.startswith(b"\xff\xd8"):
                    raise RuntimeError("Rust preview did not return a JPEG")
                return jpeg, ratio, point
        except (OSError, RuntimeError) as error:
            try:
                self.stop()
            except RuntimeError as cleanup_error:
                error.add_note(str(cleanup_error))
            raise
