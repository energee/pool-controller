"""Tests for heat/temperature decode and the Get/Set-Heat client methods.

The CFI 8 payload below is a real capture from live hardware (HANDOFF.md §10):
``54 54 55 54 46 05 ...`` → poolTemp 84, spaTemp 84, airTemp 85, poolSP 84,
spaSP 70, heatMode 5 (Heater/Heater). The stub-serial tests drive ``get_heat``/
``set_heat`` through their read/confirm loops without a live bus.
"""
from __future__ import annotations

import pytest

from easytouch import constants as C
from easytouch.controller import EasyTouch
from easytouch.decode import decode_heat_status
from easytouch.protocol import Packet
from easytouch.protocol import parse_frame as decode_frame

from stub_serial import StubSerial

# Real captured CFI 8 payload (HANDOFF.md §10).
REAL_HEAT_PAYLOAD = bytes(
    [0x54, 0x54, 0x55, 0x54, 0x46, 0x05, 0x00, 0x00, 0x00, 0x64, 0x00, 0x00, 0x00]
)

# Real controller-status (CFI 2) frame; its sub byte is 0x27, which teaches the
# client the controller's real sub-version.
REAL_STATUS = bytes.fromhex(
    "00ffa5270f10021d0b0120000000000000200c000004535320005200000005000097a6030d03d0"
)


def _heat_packet(pool_sp=0x54, spa_sp=0x46, mode=0x05) -> Packet:
    data = bytearray(REAL_HEAT_PAYLOAD)
    data[3], data[4], data[5] = pool_sp, spa_sp, mode
    return Packet(sub=0x27, dst=C.Address.BROADCAST, src=C.Address.MAIN,
                  cfi=C.Action.HEAT_STATUS, data=bytes(data))


def _heat_frame(pool_sp=0x54, spa_sp=0x46, mode=0x05) -> bytes:
    return _heat_packet(pool_sp, spa_sp, mode).to_bytes(idle=2)


def test_decode_heat_status_real_payload():
    hs = decode_heat_status(_heat_packet())
    assert hs.pool_temp == 84
    assert hs.spa_temp == 84
    assert hs.air_temp == 85
    assert hs.pool_setpoint == 84
    assert hs.spa_setpoint == 70
    assert hs.heat_mode_raw == 5
    assert hs.pool_heat_mode == "Heater"
    assert hs.spa_heat_mode == "Heater"
    # body 15 (payload idx 9) = 0x64 -> cool set-point 100°F (HANDOFF.md §13);
    # parked at 100 here since no cooling-capable heater is present.
    assert hs.cool_setpoint == 100


def test_heat_status_frame_round_trips_through_wire():
    back = decode_frame(_heat_frame())
    assert back.cfi == C.Action.HEAT_STATUS
    hs = decode_heat_status(back)
    assert (hs.pool_setpoint, hs.spa_setpoint, hs.heat_mode_raw) == (84, 70, 5)


def test_build_get_heat_frame_is_valid():
    et = EasyTouch(port="/dev/null")          # not opened; we only build packets
    back = decode_frame(et.build_get_heat().to_bytes(idle=2))
    assert back.cfi == C.Action.GET_HEAT
    assert back.dst == C.Address.MAIN
    assert back.data == bytes([0])


def test_build_set_heat_round_trips_setpoints_and_mode():
    et = EasyTouch(port="/dev/null")
    back = decode_frame(et.build_set_heat(84, 70, 5).to_bytes(idle=2))
    assert back.cfi == C.Action.SET_HEAT
    assert back.data == bytes([84, 70, 5, 0])


def test_get_heat_requests_and_returns_decoded_status():
    et = EasyTouch(port="x")
    et._serial = StubSerial(_heat_frame())
    hs = et.get_heat(timeout=1.0)
    assert (hs.pool_setpoint, hs.spa_setpoint) == (84, 70)
    # exactly one Get-Heat request went out
    assert len(et._serial.writes) == 1
    assert decode_frame(et._serial.writes[0]).cfi == C.Action.GET_HEAT


def test_get_heat_re_requests_after_learning_controller_sub():
    # On a fresh connection the sub is the default 0x01; the controller ignores a
    # request stamped with it. After a controller packet teaches the real sub, the
    # client must re-issue Get-Heat with it — otherwise the heat reply never comes.
    et = EasyTouch(port="x")                   # controller_sub defaults to 0x01
    et._serial = StubSerial(REAL_STATUS, _heat_frame())
    hs = et.get_heat(timeout=1.0)
    assert hs.pool_setpoint == 84
    gets = [decode_frame(w) for w in et._serial.writes
            if decode_frame(w).cfi == C.Action.GET_HEAT]
    assert len(gets) >= 2                       # initial + re-request after learning
    assert gets[0].sub == 0x01                  # first used the default sub
    assert gets[-1].sub == 0x27                 # re-issued with the learned sub


def test_get_heat_times_out_on_silent_bus():
    et = EasyTouch(port="x")
    et._serial = StubSerial()                  # never replies
    with pytest.raises(TimeoutError):
        et.get_heat(timeout=0.2)


def test_set_heat_read_modify_write_confirms():
    et = EasyTouch(port="x")
    # current state then the post-write echo with the new pool setpoint.
    et._serial = StubSerial(_heat_frame(pool_sp=84, spa_sp=70, mode=5),
                            _heat_frame(pool_sp=85, spa_sp=70, mode=5))
    hs = et.set_heat(pool_setpoint=85, timeout=1.0)
    assert (hs.pool_setpoint, hs.spa_setpoint, hs.heat_mode_raw) == (85, 70, 5)
    sent = [decode_frame(w) for w in et._serial.writes]
    cfis = [p.cfi for p in sent]
    assert C.Action.GET_HEAT in cfis           # the read in read-modify-write
    setpkt = next(p for p in sent if p.cfi == C.Action.SET_HEAT)
    # spa setpoint + mode preserved from the cached read, only pool changed.
    assert setpkt.data == bytes([85, 70, 5, 0])


def test_set_heat_changes_mode_bits_only():
    et = EasyTouch(port="x")
    # current mode 5 (pool=1,spa=1). Set spa mode -> 2 (solar pref): bits 2-3.
    new_mode = (5 & ~0x0C) | (2 << 2)          # 0b1001 = 9
    et._serial = StubSerial(_heat_frame(pool_sp=84, spa_sp=70, mode=5),
                            _heat_frame(pool_sp=84, spa_sp=70, mode=new_mode))
    hs = et.set_heat(spa_mode=2, timeout=1.0)
    assert hs.heat_mode_raw == new_mode
    setpkt = next(decode_frame(w) for w in et._serial.writes
                  if decode_frame(w).cfi == C.Action.SET_HEAT)
    assert setpkt.data == bytes([84, 70, new_mode, 0])
