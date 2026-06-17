"""
easytouch.constants — Pentair RS-485 protocol vocabulary.

Address map, action (CFI) codes, circuit/feature names, heat modes and run-mode
bit flags for the Pentair "A5" bus protocol used by EasyTouch / IntelliTouch
controllers and IntelliFlo pumps.

References:
- michaelusner/pentair-pool-controler PACKET_SPEC.txt (reverse-engineered spec)
- tagyoureit/nodejs-poolController field maps (embedded in PACKET_SPEC.txt)
"""
from __future__ import annotations

# --- Bus addresses ----------------------------------------------------------
# High nibble identifies the device class:
#   0x0f  broadcast    0x1x main controllers    0x2x remotes    0x6x pumps
class Address:
    CHLORINATOR = 0x02
    BROADCAST = 0x0F
    MAIN = 0x10          # IntelliTouch / EasyTouch main controller
    SECONDARY = 0x11
    REMOTE = 0x20        # a remote / wireless controller (we impersonate one)
    WIRELESS = 0x22
    PUMP1 = 0x60
    PUMP2 = 0x61
    PUMP3 = 0x62
    PUMP4 = 0x63
    INTELLICHEM = 0x90


ADDRESS_NAMES = {
    Address.CHLORINATOR: "Chlorinator",
    Address.BROADCAST: "Broadcast",
    Address.MAIN: "Main",
    Address.SECONDARY: "Secondary",
    Address.REMOTE: "Remote",
    Address.WIRELESS: "Wireless",
    Address.PUMP1: "Pump 1",
    Address.PUMP2: "Pump 2",
    Address.PUMP3: "Pump 3",
    Address.PUMP4: "Pump 4",
    Address.INTELLICHEM: "IntelliChem",
}


def is_pump(addr: int) -> bool:
    """True if ``addr`` is an IntelliFlo pump address (0x60-0x6F)."""
    return 0x60 <= addr <= 0x6F


def address_name(addr: int) -> str:
    """Human-readable name for a bus address (falls back to hex)."""
    if addr in ADDRESS_NAMES:
        return ADDRESS_NAMES[addr]
    if is_pump(addr):
        return f"Pump {addr - 0x5F}"
    return f"0x{addr:02x}"


# --- Action / command (CFI) codes ------------------------------------------
class Action:
    ACK = 1
    CONTROLLER_STATUS = 2     # unsolicited system status broadcast
    DATE_TIME = 5
    PUMP_STATUS = 7
    HEAT_STATUS = 8
    CUSTOM_NAMES = 10
    CIRCUIT_NAMES = 11
    SCHEDULE = 17             # schedule details (broadcast / response to GET_SCHEDULE)
    INTELLICHEM = 18          # IntelliChem chemistry controller status
    INTELLICHLOR_STATUS = 25
    VALVE_STATUS = 29
    SET_COLOR = 96            # 0x60 IntelliBrite light command
    SET_DATETIME = 133        # 0x85 set the controller clock
    SET_CIRCUIT = 134         # 0x86 set a circuit on/off
    SET_HEAT = 136            # 0x88 set heat set-points / mode
    SET_SCHEDULE = 145        # 0x91 write a schedule
    GET_STATUS = 194
    GET_HEAT = 200            # 0xc8 request heat/temperature status
    GET_SCHEDULE = 209        # 0xd1 request schedule(s)
    SW_VERSION = 252          # software version info
    GET_VERSION = 253         # 0xfd request software version


# Controller action names (the meaning of CFI depends on the destination; this
# table covers messages to/from a controller, which is the common case).
ACTION_NAMES = {
    1: "Ack",
    2: "Controller Status",
    5: "Date/Time",
    7: "Pump Status",
    8: "Heat/Temp Status",
    10: "Custom Names",
    11: "Circuit Names",
    16: "Heat Pump Status",
    17: "Schedule",
    18: "IntelliChem",
    25: "IntelliChlor Status",
    29: "Valve Status",
    96: "Set Color",
    133: "Set Date/Time",
    134: "Set Circuit",
    136: "Set Heat/Temp",
    145: "Set Schedule",
    194: "Get Status",
    197: "Get Date/Time",
    200: "Get Heat/Temp",
    209: "Get Schedule",
    252: "SW Version",
    253: "Get SW Version",
}

# Pump action codes (CFI when src/dst is a pump).
PUMP_ACTION_NAMES = {
    1: "Write",
    4: "Remote Control",
    5: "Set Mode",
    6: "Set Run",
    7: "Status",
}


def action_name(cfi: int, is_pump: bool = False) -> str:
    table = PUMP_ACTION_NAMES if is_pump else ACTION_NAMES
    return table.get(cfi, f"CFI {cfi}")


# --- Circuits ---------------------------------------------------------------
# EasyTouch default physical circuit numbers. The controller can rename these
# (delivered via Action.CIRCUIT_NAMES), so treat this as a convenience default
# that the caller may override.
DEFAULT_CIRCUITS = {
    1: "spa",
    2: "aux1",
    3: "aux2",
    4: "aux3",
    5: "aux4",
    6: "pool",
    7: "feature1",
    8: "feature2",
    9: "feature3",
    10: "feature4",
}
CIRCUIT_NUMBERS = {name: num for num, name in DEFAULT_CIRCUITS.items()}


def circuit_label(number: int) -> str:
    return DEFAULT_CIRCUITS.get(number, f"circuit{number}")


# --- Heat modes -------------------------------------------------------------
# The heat-mode byte packs spa (bits 2-3) and pool (bits 0-1) modes.
HEAT_MODES = {0: "Off", 1: "Heater", 2: "Solar Pref", 3: "Solar Only"}

# --- Run-mode / unit-of-measure bit flags (controller status byte 15) ------
RUNMODE_SERVICE = 0x01
RUNMODE_CELSIUS = 0x04
RUNMODE_FREEZE = 0x08


# --- IntelliBrite light commands -------------------------------------------
# Data byte for Action.SET_COLOR (CFI 96): on/off, the color-mode controls, the
# seven light shows, and the five fixed colors. This is the documented
# IntelliTouch/EasyTouch mapping (per nodejs-poolController); the command is
# global to the configured light group. NOT yet confirmed on this hardware.
LIGHT_COMMANDS = {
    "off": 0, "on": 1,
    "color_sync": 128, "color_swim": 144, "color_set": 160,
    "party": 177, "romance": 178, "caribbean": 179, "american": 180,
    "sunset": 181, "royal": 182,
    "save": 190, "recall": 191,
    "blue": 193, "green": 194, "red": 195, "white": 196, "magenta": 197,
}


def resolve_light_command(name_or_code) -> int:
    """Map an IntelliBrite command name (``party``, ``blue``, ``color-sync``…) or a
    raw 0-255 code to its command byte. Names accept ``-``/`` `` for ``_``."""
    key = str(name_or_code).strip().lower().replace("-", "_").replace(" ", "_")
    if key in LIGHT_COMMANDS:
        return LIGHT_COMMANDS[key]
    try:
        return int(str(name_or_code), 0) & 0xFF
    except ValueError as exc:
        raise ValueError(f"unknown light command: {name_or_code!r}") from exc
