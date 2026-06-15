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
    DateTime,
    HeatStatus,
    Schedule,
    decode_controller_status,
    decode_datetime,
    decode_heat_status,
    decode_schedule,
    encode_days,
    merge_heat_mode,
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
            self._serial = self._open_port()
        return self

    def _open_port(self) -> serial.Serial:
        """Open the configured port (local device or network URL).

        A ``port`` containing ``://`` is treated as a pyserial URL, so the bus can
        be reached over the network with no local socat/PTY bridge. The useful
        form is ``socket://HOST:PORT`` (raw TCP) — e.g. when an RS-485 adapter on
        another machine is exported with
        ``socat TCP-LISTEN:4000,reuseaddr /dev/cu.usbserial-XXXX,raw,b9600``.
        ``tcp://HOST:PORT`` is accepted as an alias for ``socket://``.
        """
        port = self.port_name
        if "://" in port:
            if port.startswith("tcp://"):
                port = "socket://" + port[len("tcp://"):]
            return serial.serial_for_url(port, baudrate=self.baud, timeout=self.read_timeout)
        return serial.Serial(port, self.baud, timeout=self.read_timeout)

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
    def _feed(self, chunk: bytes) -> Iterator[Packet]:
        """Decode a chunk, learning the controller sub-version as packets arrive."""
        for pkt in self._reader.feed(chunk):
            if pkt.src == C.Address.MAIN:
                self.controller_sub = pkt.sub
            yield pkt

    def packets(self, read_size: int = 256) -> Iterator[Packet]:
        """Yield decoded packets forever, learning the controller sub-version."""
        while True:
            yield from self._feed(self.serial.read(read_size))

    def _iter_until(self, deadline: float, read_size: int = 256) -> Iterator[Packet]:
        """Yield packets until ``deadline`` (monotonic seconds).

        The clock is checked every read cycle (~``read_timeout`` seconds) whether
        or not a complete packet arrived, so a silent or garbled stream still
        terminates instead of blocking forever — unlike iterating ``packets()``,
        which only yields (and thus only lets a caller check time) when a full
        frame is decoded.
        """
        while time.monotonic() < deadline:
            yield from self._feed(self.serial.read(read_size))

    def _await_main(self, cfi: int, decode_fn, timeout: float):
        """Yield decoded packets of one CFI from the main controller until ``timeout``.

        Centralizes the ``cfi``+``src == MAIN`` filter and the deadline shared by
        every request/confirm loop; the caller decides what to do with each
        decoded value (return it, re-poll, nudge) and raises ``TimeoutError`` if
        the generator runs dry.
        """
        deadline = time.monotonic() + timeout
        for pkt in self._iter_until(deadline):
            if pkt.cfi == cfi and pkt.src == C.Address.MAIN:
                yield decode_fn(pkt)

    def snapshot(self, timeout: float = 10.0) -> ControllerStatus:
        """Wait for the next controller-status broadcast and return it decoded."""
        for status in self._await_main(C.Action.CONTROLLER_STATUS,
                                       decode_controller_status, timeout):
            return status
        raise TimeoutError(f"no controller status within {timeout}s")

    # --- transmit ----------------------------------------------------------
    def send(self, pkt: Packet, idle: int = 4) -> None:
        """Write a packet to the bus (with leading idle bytes to settle the line)."""
        self.serial.write(pkt.to_bytes(idle=idle))
        self.serial.flush()

    def send_raw(self, data: bytes) -> None:
        """Write raw bytes to the bus (e.g. an IntelliChlor native-protocol frame).

        The chlorinator does not speak A5, so its frames are pre-built byte strings
        (see :func:`easytouch.intellichlor.build_set_output`) sent verbatim rather
        than encoded from a :class:`Packet`.
        """
        self.serial.write(data)
        self.serial.flush()

    def _command(self, cfi: int, *data: int) -> Packet:
        """Build a command/request packet from us (``self.address``) to the main
        controller, stamped with the learned protocol sub-version."""
        return Packet(sub=self.controller_sub, dst=C.Address.MAIN,
                      src=self.address, cfi=cfi, data=bytes(data))

    def build_set_circuit(self, circuit: int, on: bool) -> Packet:
        """Build a Set-Circuit (CFI 134) command packet to the main controller."""
        return self._command(C.Action.SET_CIRCUIT, circuit, 1 if on else 0)

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

        attempts = 0
        for status in self._await_main(C.Action.CONTROLLER_STATUS,
                                       decode_controller_status, timeout):
            if (circuit in status.circuits_on) == on:
                return status
            attempts += 1
            if attempts > retries:
                return status
            self.send(pkt)  # not there yet, nudge again
        raise TimeoutError(f"circuit {circuit} did not reach {'on' if on else 'off'}")

    # --- heat / temperature ------------------------------------------------
    def build_get_heat(self) -> Packet:
        """Build a Get-Heat (CFI 200) request to the main controller."""
        return self._command(C.Action.GET_HEAT, 0)

    def get_heat(self, timeout: float = 6.0, request: bool = True) -> HeatStatus:
        """Request and return the controller's heat/temperature status (CFI 8).

        The TCP-bridged bus is sparse, so by default this *requests* a Heat-Status
        rather than waiting passively. Pass ``request=False`` to only listen.

        On a fresh connection the controller's sub-version is not yet known, and a
        request stamped with the default sub is ignored; so the request is re-issued
        whenever a controller packet teaches us a newer sub (cf. :meth:`set_circuit`).
        """
        requested_sub = self.controller_sub
        if request:
            self.send(self.build_get_heat())
        deadline = time.monotonic() + timeout
        for pkt in self._iter_until(deadline):
            if pkt.cfi == C.Action.HEAT_STATUS and pkt.src == C.Address.MAIN:
                return decode_heat_status(pkt)
            if request and self.controller_sub != requested_sub:
                requested_sub = self.controller_sub
                self.send(self.build_get_heat())  # re-ask with the learned sub
        raise TimeoutError(f"no heat status within {timeout}s")

    def build_set_heat(self, pool_sp: int, spa_sp: int, heat_mode: int) -> Packet:
        """Build a Set-Heat (CFI 136) command: ``[poolSP, spaSP, heatMode, 0]``."""
        return self._command(C.Action.SET_HEAT, pool_sp & 0xFF, spa_sp & 0xFF,
                             heat_mode & 0xFF, 0)

    def set_heat(
        self,
        pool_setpoint: int | None = None,
        spa_setpoint: int | None = None,
        pool_mode: int | None = None,
        spa_mode: int | None = None,
        confirm: bool = True,
        timeout: float = 8.0,
    ) -> HeatStatus | None:
        """Change heat set-points and/or modes (read-modify-write).

        Set-Heat carries *all* four values at once, so any field left ``None`` is
        preserved by first reading the current heat status. ``pool_mode``/
        ``spa_mode`` are 0-3 (Off/Heater/Solar Pref/Solar Only) packed into the
        shared heat-mode byte. With ``confirm`` set, waits for the controller to
        echo the requested values back and returns that status.
        """
        cur = self.get_heat(timeout=timeout)          # read-modify-write
        psp = cur.pool_setpoint if pool_setpoint is None else pool_setpoint
        ssp = cur.spa_setpoint if spa_setpoint is None else spa_setpoint
        mode = merge_heat_mode(cur.heat_mode_raw, pool_mode, spa_mode)
        self.send(self.build_set_heat(psp, ssp, mode))
        if not confirm:
            return None
        for hs in self._await_main(C.Action.HEAT_STATUS, decode_heat_status, timeout):
            if (hs.pool_setpoint, hs.spa_setpoint, hs.heat_mode_raw) == (psp, ssp, mode):
                return hs
            self.send(self.build_get_heat())  # not there yet, re-poll
        raise TimeoutError("heat set not confirmed")

    # --- schedules ---------------------------------------------------------
    def build_get_schedules(self, schedule_id: int = 1) -> Packet:
        """Build a Get-Schedule (CFI 209) request for one slot.

        Note: this controller does **not** treat ``schedule_id=0`` as "all" — slot
        0 always answers empty. Real schedules occupy slots ``1..12`` and must be
        requested individually (see :meth:`get_schedules`).
        """
        return self._command(C.Action.GET_SCHEDULE, schedule_id)

    def get_schedules(
        self,
        count: int = 12,
        timeout: float = 6.0,
        request: bool = True,
    ) -> list[Schedule]:
        """Collect the controller's stored schedules, sorted by ID.

        Two quirks of this controller drive the sequence here:

        * A Get-Schedule for slot ``0`` returns a single empty placeholder — it is
          **not** an "all schedules" query — so real schedules in slots ``1..count``
          must be polled one id at a time.
        * Requests stamped with the default sub-version are silently ignored, so
          (when ``request``) we first wait for a MAIN frame to learn the real sub,
          then poll each slot.

        With ``request=False`` it instead passively gathers broadcast schedule
        frames until ``count`` distinct IDs are seen or ``timeout`` elapses.
        Returns an empty list if the bus serves none (e.g. a status-only sim).
        """
        schedules: dict[int, Schedule] = {}
        deadline = time.monotonic() + timeout
        if not request:
            for pkt in self._iter_until(deadline):
                if pkt.cfi == C.Action.SCHEDULE and pkt.src == C.Address.MAIN:
                    s = decode_schedule(pkt)
                    schedules[s.id] = s
                    if len(schedules) >= count:
                        break
            return [schedules[k] for k in sorted(schedules)]
        # Prime: a MAIN frame teaches EasyTouch._feed the controller's real sub so
        # the per-slot requests below are honored.
        for pkt in self._iter_until(deadline):
            if pkt.src == C.Address.MAIN:
                break
        # Poll each slot individually; the controller answers only for the id asked.
        for sid in range(1, count + 1):
            if time.monotonic() >= deadline:
                break
            self.send(self.build_get_schedules(sid))
            slot_deadline = min(deadline, time.monotonic() + 1.0)
            for pkt in self._iter_until(slot_deadline):
                if pkt.cfi == C.Action.SCHEDULE and pkt.src == C.Address.MAIN:
                    s = decode_schedule(pkt)
                    schedules[s.id] = s
                    if s.id == sid:
                        break
        return [schedules[k] for k in sorted(schedules)]

    def build_set_schedule(
        self, schedule_id: int, circuit: int, start: str, end: str, days_mask: int
    ) -> Packet:
        """Build a Set-Schedule (CFI 145) command from HH:MM strings + day mask."""
        sh, sm = _parse_hhmm(start)
        eh, em = _parse_hhmm(end)
        return self._command(C.Action.SET_SCHEDULE, schedule_id, circuit,
                             sh, sm, eh, em, days_mask & 0xFF)

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
        for s in self._await_main(C.Action.SCHEDULE, decode_schedule, timeout):
            if s.id == schedule_id:
                return s
        raise TimeoutError(f"schedule {schedule_id} was not confirmed")

    # --- clock -------------------------------------------------------------
    def build_set_datetime(self, hour: int, minute: int, dow: int, day: int,
                           month: int, year: int, auto_dst: int = 1) -> Packet:
        """Build a Set-Date/Time (CFI 133) command.

        The payload mirrors the CFI 5 broadcast field order decoded by
        :func:`~easytouch.decode.decode_datetime`:
        ``[hour, minute, dow, day, month, year, auto_dst]``. ``dow`` is the Pentair
        weekday *bit* (Sun=0x01 … Sat=0x40); ``year`` is two digits (year - 2000).
        """
        return self._command(C.Action.SET_DATETIME, hour & 0xFF, minute & 0xFF,
                             dow & 0xFF, day & 0xFF, month & 0xFF, year & 0xFF,
                             1 if auto_dst else 0)

    def set_datetime(self, when=None, auto_dst: bool = True, confirm: bool = True,
                     timeout: float = 8.0) -> DateTime | None:
        """Set the controller clock (defaults to the host's current local time).

        With ``confirm`` set, waits for a Date/Time broadcast reflecting the new
        date and hour and returns it; otherwise fires once and returns ``None``.
        """
        hour, minute, dow, day, month, year, dst = datetime_fields(when, auto_dst)
        self.send(self.build_set_datetime(hour, minute, dow, day, month, year, dst))
        if not confirm:
            return None
        for dt in self._await_main(C.Action.DATE_TIME, decode_datetime, timeout):
            if (dt.year, dt.month, dt.day, dt.hour) == (year, month, day, hour):
                return dt
        raise TimeoutError("date/time set not confirmed")


def _parse_hhmm(text: str) -> tuple[int, int]:
    """Parse a ``HH:MM`` (or ``H:MM``) time string into (hour, minute)."""
    parts = str(text).strip().split(":")
    if len(parts) != 2:
        raise ValueError(f"invalid time {text!r}, expected HH:MM")
    hour, minute = int(parts[0]), int(parts[1])
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError(f"time out of range: {text!r}")
    return hour, minute


def datetime_fields(when=None, auto_dst: bool = True):
    """Build the Set-Date/Time field tuple for a datetime (defaults to *now*).

    Returns ``(hour, minute, dow, day, month, year, auto_dst)`` where ``dow`` is
    the Pentair weekday bit (Sun=0x01 … Sat=0x40) and ``year`` is two digits.
    """
    import datetime as _dt
    when = when or _dt.datetime.now()
    dow = 1 << (when.isoweekday() % 7)        # isoweekday Mon=1..Sun=7 -> Sun = bit 0
    return (when.hour, when.minute, dow, when.day, when.month, when.year % 100,
            1 if auto_dst else 0)


def resolve_circuit(name_or_number: str) -> int:
    """Map a circuit name (e.g. ``pool``) or numeric string to a circuit number."""
    key = name_or_number.strip().lower()
    if key in C.CIRCUIT_NUMBERS:
        return C.CIRCUIT_NUMBERS[key]
    try:
        return int(key, 0)
    except ValueError as exc:
        raise ValueError(f"unknown circuit: {name_or_number!r}") from exc
