"""Tests for the high-level decoders against real captured frames."""
from __future__ import annotations

from easytouch import constants as C
from easytouch.decode import (
    ControllerStatus,
    DateTime,
    PumpStatus,
    decode,
    decode_controller_status,
    decode_datetime,
    decode_pump_status,
    equip_circuits,
)
from easytouch.protocol import Packet, parse_frame as decode_frame

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


def test_decode_controller_status_extended_fields():
    # Newly wired-in CFI 2 bytes (HANDOFF.md §13), read from REAL_STATUS:
    #   body 16 (payload idx 10) = 0x0c -> valve actuator state.
    #   body 18 (payload idx 12) = 0x00 -> no circuit currently in delay.
    #   body 32 (payload idx 26), bit 0 = 0 -> auto-DST off (manual).
    s = decode_controller_status(decode_frame(REAL_STATUS))
    assert s.valve == 12
    assert s.delay == 0
    assert s.auto_dst is False


def test_decode_datetime():
    dt = decode_datetime(REAL_DATETIME)
    assert isinstance(dt, DateTime)
    assert (dt.hour, dt.minute) == (11, 5)
    assert (dt.day, dt.month, dt.year) == (14, 6, 26)
    assert dt.iso == "2026-06-14 11:05"


# Synthetic pump-status payload with a distinct value at every documented offset,
# so a transposed or mis-read field fails the test. Each offset is labeled inline.
SYNTH_PUMP_DATA = bytes([
    0x0A,        # [0] body 6  cmd       = 10
    0x06,        # [1] body 7  mode      = 6
    0x02,        # [2] body 8  drive     = 2
    0x03, 0xE8,  # [3,4] body 9/10 watts = 0x03E8 = 1000
    0x0B, 0xB8,  # [5,6] body 11/12 rpm  = 0x0BB8 = 3000
    0x32,        # [7] body 13 gpm       = 50
    0x01,        # [8] body 14 ppc       = 1
    0x00,        # [9] body 15 err       = 0
    0x00, 0x00,  # [10,11] body 16/17 reserved
    0x05,        # [12] body 18 timer
    0x02, 0x1E,  # [13,14] body 19/20 run-time = 2h 30m -> 150 minutes
])


def test_decode_pump_status_offsets():
    pkt = Packet(sub=0x00, dst=C.Address.MAIN, src=C.Address.PUMP1,
                 cfi=C.Action.PUMP_STATUS, data=SYNTH_PUMP_DATA)
    p = decode_pump_status(pkt)
    assert isinstance(p, PumpStatus)
    assert p.pump == 1                 # src 0x60 = first pump
    assert p.cmd == 10
    assert p.mode == 6                 # body 7 (was mislabeled run_state)
    assert p.drive_state == 2          # body 8 (was mislabeled mode)
    assert p.watts == 1000
    assert p.rpm == 3000
    assert p.gpm == 50
    assert p.ppc == 1
    assert p.error == 0
    assert p.run_minutes == 150        # body 19*60 + body 20


def test_dispatch_picks_controller_status():
    s = decode(decode_frame(REAL_STATUS))
    assert isinstance(s, ControllerStatus)


def test_dispatch_unknown_for_unmapped_packet():
    pkt = Packet(sub=0, dst=0x0F, src=0x10, cfi=99, data=b"\x01\x02")
    result = decode(pkt)
    assert type(result).__name__ == "Unknown"
    assert "CFI 99" in result.description
