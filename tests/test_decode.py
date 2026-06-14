"""Tests for the high-level decoders against real captured frames."""
from __future__ import annotations

from easytouch.decode import (
    ControllerStatus,
    DateTime,
    decode,
    decode_controller_status,
    decode_datetime,
    equip_circuits,
)
from easytouch.protocol import Packet, decode as decode_frame

# Real controller-status frame (CFI 2) captured from the bus.
REAL_STATUS = bytes.fromhex(
    "00ffa5270f10021d0b0120000000000000200c000004535320005200000005000097a6030d03d0"
)
# Real date/time frame (CFI 5): hour=11 min=05 dow=01 day=14 month=06 year=26.
REAL_DATETIME = Packet(sub=0x27, dst=0x0F, src=0x10, cfi=5,
                       data=bytes([0x0B, 0x05, 0x01, 0x0E, 0x06, 0x1A, 0x00, 0x01]))


def test_equip_circuits_bit_mapping():
    # equip1 = 0x20 -> bit 5 set -> circuit 6 (Pool).
    assert equip_circuits(0x20, 0x00, 0x00) == [6]
    # bit 0 of equip1 -> circuit 1; bit 0 of equip2 -> circuit 9.
    assert equip_circuits(0x01, 0x01, 0x00) == [1, 9]
    assert equip_circuits(0x00, 0x00, 0x80) == [24]


def test_decode_controller_status_values():
    pkt = decode_frame(REAL_STATUS)
    s = decode_controller_status(pkt)
    assert isinstance(s, ControllerStatus)
    assert s.clock == "11:01"
    assert s.circuits_on == [6]
    assert s.circuit_names == ["pool"]
    assert s.pool_temp == 83          # 0x53
    assert s.spa_temp == 83
    assert s.air_temp == 82           # 0x52
    assert s.unit == "F"
    assert s.heater_on is True        # byte 22 = 0x20
    assert s.pool_heat_mode == "Heater"  # heat byte 0x05 -> pool bits 01
    assert s.spa_heat_mode == "Heater"   # spa bits 01


def test_decode_datetime():
    dt = decode_datetime(REAL_DATETIME)
    assert isinstance(dt, DateTime)
    assert (dt.hour, dt.minute) == (11, 5)
    assert (dt.day, dt.month, dt.year) == (14, 6, 26)
    assert dt.iso == "2026-06-14 11:05"


def test_dispatch_picks_controller_status():
    s = decode(decode_frame(REAL_STATUS))
    assert isinstance(s, ControllerStatus)


def test_dispatch_unknown_for_unmapped_packet():
    pkt = Packet(sub=0, dst=0x0F, src=0x10, cfi=99, data=b"\x01\x02")
    result = decode(pkt)
    assert type(result).__name__ == "Unknown"
    assert "CFI 99" in result.description
