"""
easytouch.protocol — Pentair "A5" frame encode/decode.

Wire format of an A5 packet (the dominant Pentair RS-485 protocol)::

    [idle 0xFF ...] 0x00 0xFF | 0xA5 sub dst src cfi len <data...> ckh ckl

* The frame is preceded by one or more idle ``0xFF`` bytes and a ``0x00 0xFF``
  start sequence.
* The packet body starts at ``0xA5`` and is: sub-version, destination address,
  source address, command/function (CFI), data length, then ``len`` data bytes.
* The checksum is the 16-bit unsigned sum of every body byte (``0xA5`` through
  the last data byte), transmitted big-endian (high byte first).

This module is transport-agnostic: it only turns bytes into :class:`Packet`
objects and back. See :mod:`easytouch.reader` for streaming/resync and
:mod:`easytouch.controller` for the serial client.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .constants import action_name, address_name, is_pump

# Frame markers.
IDLE = 0xFF                 # idle/preamble byte
START = bytes([0x00, 0xFF]) # start-of-frame sequence that precedes 0xA5
A5 = 0xA5                   # leading packet byte (body start)

# Offset of the first data byte within the full body (A5 sub dst src cfi len).
HEADER_LEN = 6
# Minimum on-wire body: header (6) + checksum (2), data length may be 0.
MIN_BODY = HEADER_LEN + 2


def checksum(body: bytes) -> int:
    """16-bit checksum: unsigned sum of all body bytes (0xA5 .. last data)."""
    return sum(body) & 0xFFFF


@dataclass
class Packet:
    """A decoded Pentair A5 packet.

    Attributes mirror the on-wire header. ``data`` holds only the payload
    bytes (excluding the 6-byte header and 2-byte checksum). Field offsets
    quoted elsewhere in this project are relative to the full body (``0xA5`` at
    index 0); :meth:`body` returns that full body for spec-offset indexing.
    """

    sub: int
    dst: int
    src: int
    cfi: int
    data: bytes = field(default=b"")

    @property
    def length(self) -> int:
        return len(self.data)

    @property
    def is_pump(self) -> bool:
        """True if either endpoint is a pump (CFI semantics differ for pumps)."""
        return is_pump(self.src) or is_pump(self.dst)

    def body(self) -> bytes:
        """The checksummed body: header + data (no preamble, no checksum)."""
        return bytes([A5, self.sub, self.dst, self.src, self.cfi, self.length]) + self.data

    def to_bytes(self, idle: int = 2) -> bytes:
        """Serialize to the full on-wire frame, prefixed by ``idle`` 0xFF bytes."""
        body = self.body()
        ck = checksum(body)
        return bytes([IDLE] * idle) + START + body + bytes([ck >> 8, ck & 0xFF])

    def __str__(self) -> str:
        return (
            f"{address_name(self.src)}->{address_name(self.dst)} "
            f"[{action_name(self.cfi, self.is_pump)}] "
            f"len={self.length} data={self.data.hex()}"
        )


class ChecksumError(ValueError):
    """Raised when a frame's trailing checksum does not match its body."""


def parse_frame(frame: bytes) -> Packet:
    """Decode a single A5 frame into a :class:`Packet`.

    ``frame`` may include leading idle/preamble bytes; everything before the
    first ``0xA5`` is ignored. Raises :class:`ValueError`/:class:`ChecksumError`
    on malformed input. (Named ``parse_frame`` to distinguish it from
    :func:`easytouch.decode.decode`, which turns a :class:`Packet` into state.)
    """
    a5 = frame.find(A5)
    if a5 < 0:
        raise ValueError("no 0xA5 start byte in frame")
    body_hdr = frame[a5:]
    if len(body_hdr) < MIN_BODY:
        raise ValueError("frame too short for an A5 packet")
    sub, dst, src, cfi, length = body_hdr[1], body_hdr[2], body_hdr[3], body_hdr[4], body_hdr[5]
    end = HEADER_LEN + length
    if len(body_hdr) < end + 2:
        raise ValueError("frame shorter than declared data length + checksum")
    body = body_hdr[:end]
    ckh, ckl = body_hdr[end], body_hdr[end + 1]
    got = (ckh << 8) | ckl
    want = checksum(body)
    if got != want:
        raise ChecksumError(f"checksum mismatch: frame={got} computed={want}")
    return Packet(sub=sub, dst=dst, src=src, cfi=cfi, data=bytes(body_hdr[HEADER_LEN:end]))
