"""
easytouch — a lightweight Python toolkit for the Pentair EasyTouch RS-485 bus.

Connect to the bus (a real RS-485 adapter or a ``/tmp/vserial`` PTY bridged over
TCP), decode controller/pump/date-time packets, and toggle circuits.

Quick start::

    from easytouch import EasyTouch

    with EasyTouch("/tmp/vserial") as et:
        status = et.snapshot()
        print(status.clock, status.pool_temp, status.circuit_names)
        et.set_circuit(6, on=True)   # turn the pool circuit on

Protocol details live in :mod:`easytouch.protocol` and :mod:`easytouch.constants`.
"""
from __future__ import annotations

from . import constants
from .api import serve
from .controller import DEFAULT_BAUD, DEFAULT_PORT, EasyTouch, resolve_circuit
from .decode import (
    ControllerStatus,
    DateTime,
    HeatStatus,
    PumpStatus,
    Schedule,
    Unknown,
    decode,
    decode_days,
    decode_heat_status,
    decode_schedule,
    encode_days,
    equip_circuits,
)
from .intellichlor import (
    ChlorinatorReader,
    ChlorinatorSetOutput,
    ChlorinatorStatus,
    decode_ic,
)
from .protocol import ChecksumError, Packet, checksum
from .reader import PacketReader
from .state import BusMonitor

__version__ = "0.1.0"

__all__ = [
    "EasyTouch",
    "Packet",
    "PacketReader",
    "ChecksumError",
    "ControllerStatus",
    "DateTime",
    "HeatStatus",
    "PumpStatus",
    "Schedule",
    "Unknown",
    "decode",
    "decode_schedule",
    "decode_heat_status",
    "decode_days",
    "encode_days",
    "checksum",
    "equip_circuits",
    "resolve_circuit",
    "ChlorinatorReader",
    "ChlorinatorStatus",
    "ChlorinatorSetOutput",
    "decode_ic",
    "BusMonitor",
    "serve",
    "constants",
    "DEFAULT_PORT",
    "DEFAULT_BAUD",
    "__version__",
]
