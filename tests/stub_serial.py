"""Test helper: an in-memory stand-in for a pyserial port.

Lets controller/monitor tests drive the framing and confirm loops deterministically
without a live bus — ``read()`` replays a scripted list of byte chunks (then ``b""``
forever, like an idle line) and every ``write()`` is captured for assertions.
"""
from __future__ import annotations


class StubSerial:
    """Minimal serial-like object: scripted reads, captured writes."""

    def __init__(self, *chunks: bytes) -> None:
        self._reads: list[bytes] = [bytes(c) for c in chunks]
        self.writes: list[bytes] = []

    def read(self, size: int = 1) -> bytes:
        """Return the next scripted chunk, or ``b""`` once the script is drained."""
        return self._reads.pop(0) if self._reads else b""

    def write(self, data: bytes) -> int:
        self.writes.append(bytes(data))
        return len(data)

    def flush(self) -> None:  # pragma: no cover - nothing to flush
        pass

    def close(self) -> None:  # pragma: no cover - nothing to close
        pass
