"""
easytouch.reader — streaming frame extractor with resynchronization.

The RS-485 bus is byte-oriented with no framing layer, so a reader must scan a
continuous byte stream for the ``0x00 0xFF 0xA5`` start marker, validate the
length and checksum, and resynchronize on garbage. :class:`PacketReader` keeps
an internal buffer and yields complete :class:`~easytouch.protocol.Packet`
objects as bytes arrive.
"""
from __future__ import annotations

from collections.abc import Iterator

from .protocol import A5, HEADER_LEN, Packet, checksum

# 3-byte start marker: the 0x00 0xFF preamble end followed by the 0xA5 body byte.
_MARKER = bytes([0x00, 0xFF, A5])


class PacketReader:
    """Accumulates bytes and emits validated packets.

    Usage::

        reader = PacketReader()
        for pkt in reader.feed(serial.read(256)):
            print(pkt)
    """

    def __init__(self, max_buffer: int = 4096) -> None:
        self._buf = bytearray()
        self._max_buffer = max_buffer

    def feed(self, chunk: bytes) -> list[Packet]:
        """Add bytes and return any complete packets now available."""
        if chunk:
            self._buf.extend(chunk)
        return list(self._drain())

    def _drain(self) -> Iterator[Packet]:
        buf = self._buf
        while True:
            marker = buf.find(_MARKER)
            if marker < 0:
                # Keep only a possible partial marker (last 2 bytes) to bound memory.
                if len(buf) > self._max_buffer:
                    del buf[:-2]
                return
            a5 = marker + 2  # index of the 0xA5 body start
            # Need at least the header to read the declared length.
            if len(buf) < a5 + HEADER_LEN:
                del buf[:marker]  # drop leading noise, wait for more bytes
                return
            length = buf[a5 + 5]
            end = a5 + HEADER_LEN + length          # one past last data byte
            if len(buf) < end + 2:                  # data + 2 checksum bytes
                del buf[:marker]
                return
            body = bytes(buf[a5:end])
            got = (buf[end] << 8) | buf[end + 1]
            if got == checksum(body):
                pkt = Packet(
                    sub=body[1], dst=body[2], src=body[3], cfi=body[4],
                    data=body[HEADER_LEN:],
                )
                del buf[: end + 2]
                yield pkt
            else:
                # Bad checksum: skip this marker and resync on the next one.
                del buf[: a5]
