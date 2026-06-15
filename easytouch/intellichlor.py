"""
easytouch.intellichlor — the IntelliChlor salt-chlorinator's *native* protocol.

The chlorinator does **not** speak the A5 protocol the rest of this package
decodes. It uses its own DLE-framed messages on the same RS-485 wire::

    10 02 <dest> <cmd> <data...> <chk> 10 03
    │  │   │      │     │         │     │
    │  │   │      │     │         │     └ DLE/ETX terminator
    │  │   │      │     │         └ checksum: sum(0x10 .. last data byte) & 0xFF
    │  │   │      │     └ command payload
    │  │   │      └ command (0x11 set-output, 0x12 status)
    │  │   └ destination (0x00 controller, 0x50 chlorinator)
    │  └ DLE/STX
    └ DLE

Because the A5 :class:`~easytouch.reader.PacketReader` only frames ``00 ff a5``
packets, it silently discards every chlorinator frame — which is why salt level
never appears in A5 decode or under ``/raw``. :class:`ChlorinatorReader` is a
second, independent framer over the same byte stream.

Checksum and field offsets were confirmed against live captures from the
controller at ``socket://192.168.4.70:4000`` (see ``tests/test_intellichlor.py``):
a real Set-Output frame ``10 02 50 11 1e 91 10 03`` validates the checksum rule,
and a Salt-Status frame ``10 02 00 12 37 80 …`` decodes to 2750 ppm.

.. note::
   Frame boundaries are found by the ``10 02`` / ``10 03`` markers and validated
   first by the address/command (``dest`` must be a real IC address and ``cmd`` a
   known command — this rejects A5 ``10 02 1d …`` look-alikes outright) and then by
   checksum. We do not un-stuff doubled ``0x10`` data bytes; a rare ``0x10`` payload
   byte would simply fail the checksum and be resynced past — state is never
   corrupted, only that one frame is skipped.
"""
from __future__ import annotations

from dataclasses import dataclass

DLE = 0x10
STX = 0x02
ETX = 0x03
IC_START = bytes([DLE, STX])   # 10 02
IC_END = bytes([DLE, ETX])     # 10 03

SALT_UNIT_PPM = 50             # the salt byte is reported in units of 50 ppm


class ICAddress:
    CONTROLLER = 0x00          # messages addressed to the main controller
    CHLORINATOR = 0x50         # messages addressed to the chlorinator


class ICCommand:
    SET_OUTPUT = 0x11          # controller -> chlorinator: set generation %
    STATUS = 0x12              # chlorinator -> controller: salt level + status


# Valid IntelliChlor frame headers. Used to reject A5 "10 02 …" byte look-alikes
# (A5 frames embed 0x10 0x02 as src 0x10 = MAIN + cfi 0x02 = status) at the start
# marker, before a false latch can consume bytes from a following real IC frame.
_IC_DESTS = frozenset((ICAddress.CONTROLLER, ICAddress.CHLORINATOR))      # 0x00, 0x50
_IC_COMMANDS = frozenset((ICCommand.SET_OUTPUT, ICCommand.STATUS))        # 0x11, 0x12


def ic_checksum(header_and_data: bytes) -> int:
    """IntelliChlor checksum: sum of ``0x10`` through the last data byte, mod 256."""
    return sum(header_and_data) & 0xFF


@dataclass
class ICFrame:
    """A validated raw IntelliChlor frame (one ``10 02 … 10 03`` message)."""

    dest: int
    cmd: int
    data: bytes


@dataclass
class ChlorinatorStatus:
    """Decoded ``ICCommand.STATUS`` (cmd 0x12): salt reading + raw status byte.

    ``status_flags`` is kept raw — the IntelliChlor status-bit meanings are not
    reliably reverse-engineered for every cell model, so we expose the byte
    rather than assert fault semantics we cannot verify.
    """

    salt_ppm: int
    status_flags: int


@dataclass
class ChlorinatorSetOutput:
    """Decoded ``ICCommand.SET_OUTPUT`` (cmd 0x11): requested generation percent."""

    output_percent: int


class ChlorinatorReader:
    """Streaming framer for the IntelliChlor protocol, with resync + checksum.

    Mirrors :class:`~easytouch.reader.PacketReader`: feed arbitrary byte chunks
    and get back the complete, checksum-valid frames now available.
    """

    def __init__(self, max_buffer: int = 512) -> None:
        self._buf = bytearray()
        self._max_buffer = max_buffer

    def feed(self, chunk: bytes) -> list[ICFrame]:
        """Add bytes and return any complete, validated frames now available."""
        if chunk:
            self._buf.extend(chunk)
        out: list[ICFrame] = []
        buf = self._buf
        while True:
            start = buf.find(IC_START)
            if start < 0:
                # No start marker; keep only a trailing 0x10 that might begin one.
                if len(buf) > self._max_buffer:
                    del buf[:-1]
                break
            if start > 0:
                del buf[:start]                 # drop leading noise; buf starts 10 02
            if len(buf) < 4:
                break                           # need dest+cmd to validate; await bytes
            if buf[2] not in _IC_DESTS or buf[3] not in _IC_COMMANDS:
                del buf[:2]                     # A5 "10 02 …" look-alike — not IC; resync
                continue
            end = buf.find(IC_END, 2)           # terminator after the start marker
            if end < 0:
                if len(buf) > self._max_buffer:
                    del buf[:2]                 # runaway: drop this start, resync
                    continue
                break                           # incomplete; wait for more bytes
            inner = bytes(buf[2:end])           # dest, cmd, data..., chk
            if len(inner) >= 3:
                chk = inner[-1]
                body = bytes(buf[:end - 1])     # 0x10 .. last data byte (excl. chk)
                if ic_checksum(body) == chk:
                    out.append(ICFrame(dest=inner[0], cmd=inner[1], data=inner[2:-1]))
                    del buf[: end + 2]
                    continue
            del buf[:2]                         # bad/short frame: drop start, resync
        return out

    def reset(self) -> None:
        self._buf.clear()


def build_set_output(percent: int, dest: int = ICAddress.CHLORINATOR) -> bytes:
    """Build an IntelliChlor Set-Output frame: ``10 02 <dest> 11 <pct> <chk> 10 03``.

    ``percent`` is the chlorine-generation level 0–100 (clamped). Returns the raw
    on-wire bytes: the chlorinator speaks its native protocol, not A5, so this is
    written to the bus verbatim (see
    :meth:`easytouch.controller.EasyTouch.send_raw`) rather than wrapped in a
    :class:`~easytouch.protocol.Packet`. Byte-for-byte matches the real captured
    frame ``10 02 50 11 1e 91 10 03`` (30%).

    .. note::
       On a system with a *present* EasyTouch controller the controller also drives
       the cell and may overwrite a directly-injected output on its next cycle, so
       treat this as best-effort (see HANDOFF for the override caveat).
    """
    pct = max(0, min(100, int(percent)))
    body = bytes([DLE, STX, dest, ICCommand.SET_OUTPUT, pct])
    return body + bytes([ic_checksum(body)]) + IC_END


def decode_ic(frame: ICFrame):
    """Decode a validated :class:`ICFrame` into a typed value, or ``None``."""
    if frame.cmd == ICCommand.STATUS and len(frame.data) >= 2:
        return ChlorinatorStatus(salt_ppm=frame.data[0] * SALT_UNIT_PPM,
                                 status_flags=frame.data[1])
    if frame.cmd == ICCommand.SET_OUTPUT and len(frame.data) >= 1:
        return ChlorinatorSetOutput(output_percent=frame.data[0])
    return None
