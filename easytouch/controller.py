"""
easytouch.controller — high-level client for a Pentair EasyTouch over RS-485.

:class:`EasyTouch` wraps a serial port (e.g. the ``/tmp/vserial`` PTY bridged to
the bus) and provides a small, friendly API:

* iterate decoded packets as they arrive (:meth:`packets`)
* grab the next full system snapshot (:meth:`snapshot`)
* turn circuits on/off (:meth:`set_circuit`)

It learns the controller's protocol sub-version from observed traffic so that
commands it injects match the live bus.
"""
from __future__ import annotations

import time
from collections.abc import Iterator

import serial  # pyserial

from . import constants as C
from .decode import (
    ControllerStatus,
    Schedule,
    decode_controller_status,
    decode_schedule,
    encode_days,
)
from .protocol import Packet
from .reader import PacketReader

DEFAULT_PORT = "/tmp/vserial"
DEFAULT_BAUD = 9600


class EasyTouch:
    """Connection to a Pentair controller on an RS-485 serial bus."""

    def __init__(
        self,
        port: str = DEFAULT_PORT,
        baud: int = DEFAULT_BAUD,
        address: int = C.Address.REMOTE,
        read_timeout: float = 0.3,
        default_sub: int = 0x01,
    ) -> None:
        self.port_name = port
        self.baud = baud
        self.address = address          # the address we send *from*
        self.read_timeout = read_timeout
        self._serial: serial.Serial | None = None
        self._reader = PacketReader()
        # Protocol sub/version byte to use for outgoing frames. Updated from the
        # bus as soon as we see the controller talk; falls back to default_sub.
        self.controller_sub = default_sub

    # --- lifecycle ---------------------------------------------------------
    def open(self) -> "EasyTouch":
        if self._serial is None:
            self._serial = serial.Serial(self.port_name, self.baud, timeout=self.read_timeout)
        return self

    def close(self) -> None:
        if self._serial is not None:
            self._serial.close()
            self._serial = None

    def __enter__(self) -> "EasyTouch":
        return self.open()

    def __exit__(self, *exc) -> None:
        self.close()

    @property
    def serial(self) -> serial.Serial:
        if self._serial is None:
            raise RuntimeError("port is not open; call open() or use a 'with' block")
        return self._serial

    # --- receive -----------------------------------------------------------
    def packets(self, read_size: int = 256) -> Iterator[Packet]:
        """Yield decoded packets forever, learning the controller sub-version."""
        while True:
            chunk = self.serial.read(read_size)
            for pkt in self._reader.feed(chunk):
                if pkt.src == C.Address.MAIN:
                    self.controller_sub = pkt.sub
                yield pkt

    def snapshot(self, timeout: float = 10.0) -> ControllerStatus:
        """Wait for the next controller-status broadcast and return it decoded."""
        deadline = time.monotonic() + timeout
        for pkt in self.packets():
            if pkt.cfi == C.Action.CONTROLLER_STATUS and pkt.src == C.Address.MAIN:
                return decode_controller_status(pkt)
            if time.monotonic() > deadline:
                break
        raise TimeoutError(f"no controller status within {timeout}s")

    # --- transmit ----------------------------------------------------------
    def send(self, pkt: Packet, idle: int = 4) -> None:
        """Write a packet to the bus (with leading idle bytes to settle the line)."""
        self.serial.write(pkt.to_bytes(idle=idle))
        self.serial.flush()

    def build_set_circuit(self, circuit: int, on: bool) -> Packet:
        """Build a Set-Circuit (CFI 134) command packet to the main controller."""
        return Packet(
            sub=self.controller_sub,
            dst=C.Address.MAIN,
            src=self.address,
            cfi=C.Action.SET_CIRCUIT,
            data=bytes([circuit, 1 if on else 0]),
        )

    def set_circuit(
        self,
        circuit: int,
        on: bool,
        confirm: bool = True,
        retries: int = 3,
        timeout: float = 6.0,
    ) -> ControllerStatus | None:
        """Turn a circuit on/off.

        If ``confirm`` is set, the call retries until a controller-status
        broadcast reflects the requested state (or ``retries`` is exhausted) and
        returns that status. With ``confirm=False`` it fires once and returns
        ``None``.
        """
        pkt = self.build_set_circuit(circuit, on)
        self.send(pkt)
        if not confirm:
            return None

        deadline = time.monotonic() + timeout
        attempts = 0
        for raw in self.packets():
            if raw.cfi == C.Action.CONTROLLER_STATUS and raw.src == C.Address.MAIN:
                status = decode_controller_status(raw)
                if (circuit in status.circuits_on) == on:
                    return status
                attempts += 1
                if attempts > retries:
                    return status
                self.send(pkt)  # not there yet, nudge again
            if time.monotonic() > deadline:
                raise TimeoutError(f"circuit {circuit} did not reach {'on' if on else 'off'}")
        return None

    # --- schedules ---------------------------------------------------------
    def build_get_schedules(self, schedule_id: int = 0) -> Packet:
        """Build a Get-Schedule (CFI 209) request (``schedule_id=0`` = all)."""
        return Packet(
            sub=self.controller_sub,
            dst=C.Address.MAIN,
            src=self.address,
            cfi=C.Action.GET_SCHEDULE,
            data=bytes([schedule_id]),
        )

    def get_schedules(
        self,
        count: int = 12,
        timeout: float = 6.0,
        request: bool = True,
    ) -> list[Schedule]:
        """Collect schedule entries broadcast by the controller.

        Sends a Get-Schedule request (unless ``request=False``) then gathers
        ``Action.SCHEDULE`` packets until ``count`` distinct IDs are seen or
        ``timeout`` elapses. Returns whatever arrived, sorted by ID — an empty
        list if the controller serves none (e.g. a status-only simulator).
        """
        if request:
            self.send(self.build_get_schedules())
        schedules: dict[int, Schedule] = {}
        deadline = time.monotonic() + timeout
        for pkt in self.packets():
            if pkt.cfi == C.Action.SCHEDULE and pkt.src == C.Address.MAIN:
                s = decode_schedule(pkt)
                schedules[s.id] = s
                if len(schedules) >= count:
                    break
            if time.monotonic() > deadline:
                break
        return [schedules[k] for k in sorted(schedules)]

    def build_set_schedule(
        self, schedule_id: int, circuit: int, start: str, end: str, days_mask: int
    ) -> Packet:
        """Build a Set-Schedule (CFI 145) command from HH:MM strings + day mask."""
        sh, sm = _parse_hhmm(start)
        eh, em = _parse_hhmm(end)
        return Packet(
            sub=self.controller_sub,
            dst=C.Address.MAIN,
            src=self.address,
            cfi=C.Action.SET_SCHEDULE,
            data=bytes([schedule_id, circuit, sh, sm, eh, em, days_mask & 0xFF]),
        )

    def set_schedule(
        self,
        schedule_id: int,
        circuit: int,
        start: str,
        end: str,
        days,
        confirm: bool = True,
        timeout: float = 8.0,
    ) -> Schedule | None:
        """Write a schedule. ``days`` is a mask (int) or an iterable of day tokens.

        With ``confirm`` set, waits for the controller to broadcast the matching
        schedule ID back and returns it; otherwise fires once and returns None.
        """
        days_mask = days if isinstance(days, int) else encode_days(days)
        pkt = self.build_set_schedule(schedule_id, circuit, start, end, days_mask)
        self.send(pkt)
        if not confirm:
            return None
        deadline = time.monotonic() + timeout
        for raw in self.packets():
            if raw.cfi == C.Action.SCHEDULE and raw.src == C.Address.MAIN:
                s = decode_schedule(raw)
                if s.id == schedule_id:
                    return s
            if time.monotonic() > deadline:
                raise TimeoutError(f"schedule {schedule_id} was not confirmed")
        return None


def _parse_hhmm(text: str) -> tuple[int, int]:
    """Parse a ``HH:MM`` (or ``H:MM``) time string into (hour, minute)."""
    parts = str(text).strip().split(":")
    if len(parts) != 2:
        raise ValueError(f"invalid time {text!r}, expected HH:MM")
    hour, minute = int(parts[0]), int(parts[1])
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError(f"time out of range: {text!r}")
    return hour, minute


def resolve_circuit(name_or_number: str) -> int:
    """Map a circuit name (e.g. ``pool``) or numeric string to a circuit number."""
    key = name_or_number.strip().lower()
    if key in C.CIRCUIT_NUMBERS:
        return C.CIRCUIT_NUMBERS[key]
    try:
        return int(key, 0)
    except ValueError as exc:
        raise ValueError(f"unknown circuit: {name_or_number!r}") from exc
