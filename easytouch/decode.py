"""
easytouch.decode — turn raw packets into meaningful state.

Field offsets below are quoted relative to the full packet body with ``0xA5`` at
index 0 (matching PACKET_SPEC.txt and the nodejs-poolController field maps), so
they read directly against ``Packet.body_byte(n)``. Data byte *n* of the payload
is therefore body offset ``n + 6``.

Only the well-understood, field-validated packets are decoded into typed
structures; everything else is returned as a generic description so monitoring
never silently drops a frame.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from . import constants as C
from .protocol import Packet


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
    """Decoded IntelliFlo pump status (CFI 7 from a pump)."""

    pump: int          # 1-based pump number
    watts: int
    rpm: int
    gpm: int
    run_state: int
    mode: int


@dataclass
class HeatStatus:
    """Decoded ``Action.HEAT_STATUS`` (CFI 8) — temps and heat set-points.

    Payload layout (validated against live hardware):
    ``[poolTemp, spaTemp, airTemp, poolSetpoint, spaSetpoint, heatMode, ...]``.
    """

    pool_temp: int
    spa_temp: int
    air_temp: int
    pool_setpoint: int
    spa_setpoint: int
    pool_heat_mode: str
    spa_heat_mode: str
    heat_mode_raw: int


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
    ``weekdays`` (Mon-Fri) and ``weekends`` (Sat+Sun).
    """
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
    b = pkt.body_byte
    equip = (b(8), b(9), b(10))
    circuits = equip_circuits(*equip)
    runmode = b(15)
    heat_mode = b(28)
    return ControllerStatus(
        clock=f"{b(6):02d}:{b(7):02d}",
        circuits_on=circuits,
        circuit_names=[C.circuit_label(c) for c in circuits],
        pool_temp=b(20),
        spa_temp=b(21),
        air_temp=b(24),
        solar_temp=b(25),
        heater_on=b(22) != 0,
        pool_heat_mode=C.HEAT_MODES.get(heat_mode & 0x03, "?"),
        spa_heat_mode=C.HEAT_MODES.get((heat_mode >> 2) & 0x03, "?"),
        celsius=bool(runmode & C.RUNMODE_CELSIUS),
        service=bool(runmode & C.RUNMODE_SERVICE),
        freeze=bool(runmode & C.RUNMODE_FREEZE),
        raw_equip=equip,
    )


def decode_datetime(pkt: Packet) -> DateTime:
    b = pkt.body_byte
    # data: hour, minute, dow, day, month, year, ...
    return DateTime(
        hour=b(6), minute=b(7), dow=b(8), day=b(9), month=b(10), year=b(11),
    )


def decode_pump_status(pkt: Packet) -> PumpStatus:
    b = pkt.body_byte
    pump_num = (pkt.src - C.Address.PUMP1 + 1) if 0x60 <= pkt.src <= 0x6F else 0
    return PumpStatus(
        pump=pump_num,
        watts=(b(9) << 8) | b(10),
        rpm=(b(11) << 8) | b(12),
        gpm=b(13),
        run_state=b(7),
        mode=b(8),
    )


def decode_schedule(pkt: Packet) -> Schedule:
    b = pkt.body_byte
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
    d = pkt.data

    def g(i: int) -> int:
        return d[i] if i < len(d) else 0

    mode = g(5)
    return HeatStatus(
        pool_temp=g(0),
        spa_temp=g(1),
        air_temp=g(2),
        pool_setpoint=g(3),
        spa_setpoint=g(4),
        pool_heat_mode=C.HEAT_MODES.get(mode & 0x03, "?"),
        spa_heat_mode=C.HEAT_MODES.get((mode >> 2) & 0x03, "?"),
        heat_mode_raw=mode,
    )


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
    if pkt.cfi == C.Action.PUMP_STATUS and 0x60 <= pkt.src <= 0x6F:
        return decode_pump_status(pkt)
    return Unknown(packet=pkt, description=str(pkt))
