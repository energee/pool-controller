"""
easytouch.decode — turn raw packets into meaningful state.

Field offsets below are quoted relative to the full packet body with ``0xA5`` at
index 0 (matching PACKET_SPEC.txt and the nodejs-poolController field maps), so
they read directly against the once-built body accessor returned by
``_spec_reader``. Data byte *n* of the payload is therefore body offset ``n + 6``.

Only the well-understood, field-validated packets are decoded into typed
structures; everything else is returned as a generic description so monitoring
never silently drops a frame.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from . import constants as C
from .protocol import Packet


def _spec_reader(pkt: Packet):
    """Safe spec-offset byte accessor over ``pkt``'s body, built once.

    The full packet body (``0xA5`` at index 0) is constructed a single time; the
    returned ``b(i)`` reads byte *i* and yields ``0`` for offsets past the end —
    so a decoder reads documented offsets without rebuilding the body per access
    or bounds-checking short frames itself.
    """
    body = pkt.body()
    return lambda i: body[i] if i < len(body) else 0


def equip_circuits(equip1: int, equip2: int, equip3: int) -> list[int]:
    """Decode the 3 equipment bitmask bytes into a list of ON circuit numbers.

    Bit *i* (LSB first) of equip1 is circuit ``i+1``; equip2 covers circuits
    9-16 and equip3 covers 17-24.
    """
    on: list[int] = []
    for byte_index, value in enumerate((equip1, equip2, equip3)):
        for bit in range(8):
            if value & (1 << bit):
                on.append(byte_index * 8 + bit + 1)
    return on


def heat_modes(byte: int) -> tuple[str, str]:
    """Decode the packed heat-mode byte into ``(pool_mode, spa_mode)`` names.

    The byte packs pool mode in bits 0-1 and spa mode in bits 2-3 (see
    :data:`constants.HEAT_MODES`); shared by every decoder that reports heat mode.
    """
    return C.HEAT_MODES.get(byte & 0x03, "?"), C.HEAT_MODES.get((byte >> 2) & 0x03, "?")


def merge_heat_mode(current_raw: int, pool_mode: int | None, spa_mode: int | None) -> int:
    """Apply optional pool/spa mode changes onto the packed heat-mode byte.

    Pool mode occupies bits 0-1 and spa mode bits 2-3; a ``None`` mode leaves its
    bits untouched. Shared by every Set-Heat read-modify-write (the controller and
    the BusMonitor) so the bit-packing lives in exactly one place.
    """
    mode = current_raw
    if pool_mode is not None:
        mode = (mode & ~0x03) | (pool_mode & 0x03)
    if spa_mode is not None:
        mode = (mode & ~0x0C) | ((spa_mode & 0x03) << 2)
    return mode


@dataclass
class ControllerStatus:
    """Decoded ``Action.CONTROLLER_STATUS`` (CFI 2) broadcast."""

    clock: str                      # "HH:MM"
    circuits_on: list[int]          # physical circuit numbers currently on
    circuit_names: list[str]        # convenience names for circuits_on
    pool_temp: int
    spa_temp: int
    air_temp: int
    solar_temp: int
    heater_on: bool
    pool_heat_mode: str
    spa_heat_mode: str
    celsius: bool
    service: bool
    freeze: bool
    valve: int          # body 16: valve actuator state (raw byte)
    delay: int          # body 18: 0 = none; 65-135 = the circuit currently delayed
    auto_dst: bool      # body 32 bit 0: auto-adjust daylight saving time
    raw_equip: tuple[int, int, int]

    @property
    def unit(self) -> str:
        return "C" if self.celsius else "F"


@dataclass
class DateTime:
    """Decoded ``Action.DATE_TIME`` (CFI 5) broadcast."""

    hour: int
    minute: int
    day: int
    month: int
    year: int
    dow: int

    @property
    def iso(self) -> str:
        return f"{2000 + self.year:04d}-{self.month:02d}-{self.day:02d} {self.hour:02d}:{self.minute:02d}"


@dataclass
class PumpStatus:
    """Decoded IntelliFlo pump status (CFI 7 from a pump).

    Fields follow ``pumpPacketFields``; the body offset of each is in its
    per-field comment below. ``mode``, ``drive_state`` and ``error`` are raw
    controller codes — deliberately left unmapped (no named lookup yet, unlike
    heat modes or circuit names) until their value tables are reverse-engineered.
    """

    pump: int          # 1-based pump number
    cmd: int           # body 6: controller command to the pump
    mode: int          # body 7: pump program/mode
    drive_state: int   # body 8: drive state
    watts: int
    rpm: int
    gpm: int
    ppc: int           # body 14: pump-to-pump comms / priming-cycle counter
    error: int         # body 15: error code (0 = ok)
    run_minutes: int   # body 19*60 + body 20: elapsed run-time clock, in minutes


@dataclass
class HeatStatus:
    """Decoded ``Action.HEAT_STATUS`` (CFI 8) — temps and heat set-points.

    Payload layout (validated against live hardware):
    ``[poolTemp, spaTemp, airTemp, poolSetpoint, spaSetpoint, heatMode, ...]``.
    Payload idx 9 (body 15) carries the cool set-point used by cooling-capable
    heaters (heat-pump / UltraTemp); it reads ``100`` when no chill is configured.
    """

    pool_temp: int
    spa_temp: int
    air_temp: int
    pool_setpoint: int
    spa_setpoint: int
    pool_heat_mode: str
    spa_heat_mode: str
    heat_mode_raw: int
    cool_setpoint: int      # body 15: heat-pump/UltraTemp chill set-point (100 = parked)


@dataclass
class SoftwareVersion:
    """Decoded ``Action.SW_VERSION`` (CFI 252) — controller firmware version.

    .. note::
       The exact field layout is **not confirmed** against this hardware (no CFI 252
       frame was captured). ``version`` is a best-effort read of the first two
       payload bytes as ``major.minor``; ``raw`` (the full payload hex) is the
       authoritative value until the layout is verified on a live controller.
    """

    version: str        # best-effort "major.minor"
    major: int
    minor: int
    raw: str            # hex of the full payload


@dataclass
class ValveStatus:
    """Decoded ``Action.VALVE_STATUS`` (CFI 29) — valve actuator assignments.

    .. note::
       Per-byte meanings are **not confirmed** against this hardware (no CFI 29
       frame captured). ``valves`` is the raw per-position payload and ``raw`` the
       full payload hex — surfaced typed (instead of only under ``/raw``) so a live
       capture can be matched against it later.
    """

    valves: list[int]
    raw: str


# --- Schedules --------------------------------------------------------------
# Day-of-week bitmask, per the nodejs-poolController convention. The raw byte is
# always exposed alongside the decoded names in case a controller orders the
# bits differently.
DAY_BITS = [
    ("Sun", 0x01), ("Mon", 0x02), ("Tue", 0x04), ("Wed", 0x08),
    ("Thu", 0x10), ("Fri", 0x20), ("Sat", 0x40),
]
ALL_DAYS = 0x7F  # every day

_DAY_ALIASES: dict[str, int] = {}
for _full, _abbr, _bit in [
    ("sunday", "sun", 0x01), ("monday", "mon", 0x02), ("tuesday", "tue", 0x04),
    ("wednesday", "wed", 0x08), ("thursday", "thu", 0x10), ("friday", "fri", 0x20),
    ("saturday", "sat", 0x40),
]:
    _DAY_ALIASES[_full] = _bit
    _DAY_ALIASES[_abbr] = _bit


def decode_days(mask: int) -> list[str]:
    """Decode a day bitmask into a list of day names (``["Every day"]`` if all)."""
    if mask & ALL_DAYS == ALL_DAYS:
        return ["Every day"]
    return [name for name, bit in DAY_BITS if mask & bit]


def encode_days(tokens) -> int:
    """Build a day bitmask from tokens like ``mon``, ``tuesday``, ``weekdays``.

    Accepts day names/abbreviations plus the shortcuts ``every``/``all``/``daily``,
    ``weekdays`` (Mon-Fri) and ``weekends`` (Sat+Sun). ``tokens`` may be an
    iterable of tokens *or* a single comma/space-separated string (e.g.
    ``"mon,wed,fri"`` or ``"every"``) — the form the HTTP API / webapp send.
    """
    if isinstance(tokens, str):
        tokens = tokens.replace(",", " ").split()
    mask = 0
    for token in tokens:
        key = token.strip().lower()
        if not key:
            continue
        if key in ("every", "everyday", "all", "daily"):
            return ALL_DAYS
        if key == "weekdays":
            mask |= 0x3E  # Mon..Fri
        elif key == "weekends":
            mask |= 0x41  # Sun + Sat
        elif key in _DAY_ALIASES:
            mask |= _DAY_ALIASES[key]
        else:
            raise ValueError(f"unknown day: {token!r}")
    return mask


@dataclass
class Schedule:
    """Decoded ``Action.SCHEDULE`` (CFI 17) entry.

    A schedule with ``circuit == 0`` is an unused/empty slot. Start/stop are
    24-hour ``HH:MM`` strings; controllers encode "egg-timer" run-for-duration
    schedules with out-of-range hours, so raw bytes are kept available.
    """

    id: int
    circuit: int
    circuit_name: str
    start: str          # "HH:MM"
    end: str            # "HH:MM"
    days_mask: int
    days: list[str]

    @property
    def active(self) -> bool:
        return self.circuit != 0


@dataclass
class Unknown:
    """Fallback for packets without a dedicated decoder."""

    packet: Packet = field(repr=False)
    description: str = ""


def decode_controller_status(pkt: Packet) -> ControllerStatus:
    b = _spec_reader(pkt)
    equip = (b(8), b(9), b(10))
    circuits = equip_circuits(*equip)
    runmode = b(15)
    pool_mode, spa_mode = heat_modes(b(28))
    return ControllerStatus(
        clock=f"{b(6):02d}:{b(7):02d}",
        circuits_on=circuits,
        circuit_names=[C.circuit_label(c) for c in circuits],
        pool_temp=b(20),
        spa_temp=b(21),
        air_temp=b(24),
        solar_temp=b(25),
        heater_on=b(22) != 0,
        pool_heat_mode=pool_mode,
        spa_heat_mode=spa_mode,
        celsius=bool(runmode & C.RUNMODE_CELSIUS),
        service=bool(runmode & C.RUNMODE_SERVICE),
        freeze=bool(runmode & C.RUNMODE_FREEZE),
        valve=b(16),
        delay=b(18),
        auto_dst=bool(b(32) & 0x01),
        raw_equip=equip,
    )


def decode_datetime(pkt: Packet) -> DateTime:
    b = _spec_reader(pkt)
    # data: hour, minute, dow, day, month, year, ...
    return DateTime(
        hour=b(6), minute=b(7), dow=b(8), day=b(9), month=b(10), year=b(11),
    )


def decode_pump_status(pkt: Packet) -> PumpStatus:
    b = _spec_reader(pkt)
    pump_num = (pkt.src - C.Address.PUMP1 + 1) if C.is_pump(pkt.src) else 0
    return PumpStatus(
        pump=pump_num,
        cmd=b(6),
        mode=b(7),
        drive_state=b(8),
        watts=(b(9) << 8) | b(10),
        rpm=(b(11) << 8) | b(12),
        gpm=b(13),
        ppc=b(14),
        error=b(15),
        run_minutes=b(19) * 60 + b(20),
    )


def decode_schedule(pkt: Packet) -> Schedule:
    b = _spec_reader(pkt)
    circuit = b(7)
    mask = b(12)
    return Schedule(
        id=b(6),
        circuit=circuit,
        circuit_name=C.circuit_label(circuit) if circuit else "(unused)",
        start=f"{b(8):02d}:{b(9):02d}",
        end=f"{b(10):02d}:{b(11):02d}",
        days_mask=mask,
        days=decode_days(mask),
    )


def decode_heat_status(pkt: Packet) -> HeatStatus:
    b = _spec_reader(pkt)
    # data: poolTemp, spaTemp, airTemp, poolSetpoint, spaSetpoint, heatMode, ...
    mode = b(11)
    pool_mode, spa_mode = heat_modes(mode)
    return HeatStatus(
        pool_temp=b(6),
        spa_temp=b(7),
        air_temp=b(8),
        pool_setpoint=b(9),
        spa_setpoint=b(10),
        pool_heat_mode=pool_mode,
        spa_heat_mode=spa_mode,
        heat_mode_raw=mode,
        cool_setpoint=b(15),
    )


def decode_version(pkt: Packet) -> SoftwareVersion:
    b = _spec_reader(pkt)
    major, minor = b(6), b(7)
    return SoftwareVersion(version=f"{major}.{minor:03d}", major=major, minor=minor,
                           raw=bytes(pkt.data).hex())


def decode_valve(pkt: Packet) -> ValveStatus:
    data = bytes(pkt.data)
    return ValveStatus(valves=list(data), raw=data.hex())


def decode(pkt: Packet):
    """Dispatch a packet to the most specific decoder available.

    Returns a typed dataclass for known packets, or :class:`Unknown` otherwise.
    """
    if pkt.cfi == C.Action.CONTROLLER_STATUS and pkt.src == C.Address.MAIN:
        return decode_controller_status(pkt)
    if pkt.cfi == C.Action.DATE_TIME and pkt.src == C.Address.MAIN:
        return decode_datetime(pkt)
    if pkt.cfi == C.Action.HEAT_STATUS and pkt.src == C.Address.MAIN:
        return decode_heat_status(pkt)
    if pkt.cfi == C.Action.SCHEDULE and pkt.src == C.Address.MAIN:
        return decode_schedule(pkt)
    if pkt.cfi == C.Action.PUMP_STATUS and C.is_pump(pkt.src):
        return decode_pump_status(pkt)
    if pkt.cfi == C.Action.SW_VERSION and pkt.src == C.Address.MAIN:
        return decode_version(pkt)
    if pkt.cfi == C.Action.VALVE_STATUS and pkt.src == C.Address.MAIN:
        return decode_valve(pkt)
    return Unknown(packet=pkt, description=str(pkt))
