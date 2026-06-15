"""Tests for schedule decode/encode and the Set/Get schedule frame builders.

No live controller serves schedules in this environment, so these exercise the
protocol with synthetic frames built by the encoder and round-tripped through
the decoder.
"""
from __future__ import annotations

from easytouch import constants as C
from easytouch.controller import EasyTouch, _parse_hhmm
from easytouch.decode import (
    Schedule,
    decode,
    decode_days,
    decode_schedule,
    encode_days,
)
from easytouch.protocol import Packet
from easytouch.protocol import parse_frame as decode_frame

from stub_serial import StubSerial


REAL_STATUS = bytes.fromhex(
    "00ffa5270f10021d0b0120000000000000200c000004535320005200000005000097a6030d03d0"
)


def _schedule_packet(sid, circuit, sh, sm, eh, em, days) -> Packet:
    return Packet(sub=0x01, dst=C.Address.BROADCAST, src=C.Address.MAIN,
                  cfi=C.Action.SCHEDULE,
                  data=bytes([sid, circuit, sh, sm, eh, em, days]))


def test_decode_days_basics():
    assert decode_days(0x00) == []
    assert decode_days(0x02 | 0x08 | 0x20) == ["Mon", "Wed", "Fri"]
    assert decode_days(0x7F) == ["Every day"]
    assert decode_days(0xFF) == ["Every day"]


def test_encode_days_round_trip_and_shortcuts():
    assert encode_days(["mon", "wed", "fri"]) == 0x2A
    assert decode_days(encode_days(["mon", "wed", "fri"])) == ["Mon", "Wed", "Fri"]
    assert encode_days(["every"]) == 0x7F


def test_encode_days_accepts_comma_or_space_separated_string():
    # The HTTP API / webapp send `days` as a raw string, not a list. encode_days
    # must accept it — previously a string iterated per-character and raised
    # "unknown day: 'm'", surfacing as POST /schedule -> HTTP 400.
    assert encode_days("mon,wed,fri") == 0x2A
    assert encode_days("every") == 0x7F
    assert encode_days("mon wed fri") == 0x2A
    assert encode_days("") == 0
    assert encode_days(["weekdays"]) == 0x3E       # Mon..Fri
    assert encode_days(["weekends"]) == 0x41       # Sun + Sat
    assert encode_days(["Sunday", "Saturday"]) == 0x41


def test_encode_days_rejects_garbage():
    import pytest
    with pytest.raises(ValueError):
        encode_days(["funday"])


def test_decode_schedule_fields():
    pkt = _schedule_packet(1, 6, 8, 0, 10, 30, 0x2A)  # pool, 08:00-10:30, MWF
    s = decode_schedule(pkt)
    assert isinstance(s, Schedule)
    assert s.id == 1
    assert s.circuit == 6
    assert s.circuit_name == "pool"
    assert s.start == "08:00"
    assert s.end == "10:30"
    assert s.days_mask == 0x2A
    assert s.days == ["Mon", "Wed", "Fri"]
    assert s.active is True


def test_unused_schedule_slot():
    s = decode_schedule(_schedule_packet(5, 0, 0, 0, 0, 0, 0))
    assert s.active is False
    assert s.circuit_name == "(unused)"


def test_schedule_packet_round_trips_through_wire():
    pkt = _schedule_packet(3, 1, 18, 15, 21, 0, 0x7F)
    frame = pkt.to_bytes(idle=2)
    again = decode_frame(frame)            # validates checksum
    s = decode_schedule(again)
    assert s.id == 3 and s.circuit == 1
    assert s.start == "18:15" and s.end == "21:00"
    assert s.days == ["Every day"]


def test_dispatch_routes_schedule():
    s = decode(_schedule_packet(2, 6, 7, 0, 9, 0, 0x10))
    assert isinstance(s, Schedule)
    assert s.days == ["Thu"]


def test_build_get_schedules_frame_is_valid():
    et = EasyTouch(port="/dev/null")       # not opened; we only build packets
    pkt = et.build_get_schedules(3)
    frame = pkt.to_bytes(idle=2)
    back = decode_frame(frame)
    assert back.cfi == C.Action.GET_SCHEDULE
    assert back.dst == C.Address.MAIN
    assert back.data == bytes([3])         # one slot id per request (0 = empty)


def test_build_get_schedules_defaults_to_slot_one_not_zero():
    # Slot 0 always answers empty on this controller, so the default request must
    # target a real slot (1), never the useless id-0 "all" query.
    et = EasyTouch(port="/dev/null")
    assert decode_frame(et.build_get_schedules().to_bytes(idle=2)).data == bytes([1])


def test_build_set_schedule_frame_round_trips():
    et = EasyTouch(port="/dev/null")
    pkt = et.build_set_schedule(4, 6, "06:30", "22:00", 0x3E)
    frame = pkt.to_bytes(idle=2)
    back = decode_frame(frame)
    assert back.cfi == C.Action.SET_SCHEDULE
    s = decode_schedule(back)
    assert s.id == 4 and s.circuit == 6
    assert s.start == "06:30" and s.end == "22:00"
    assert s.days == ["Mon", "Tue", "Wed", "Thu", "Fri"]


def test_get_schedules_polls_per_slot_with_learned_sub():
    # The controller ignores Get-Schedule stamped with the default sub AND answers
    # only for the slot id in the request, so get_schedules must (1) wait for a
    # MAIN frame to learn the real sub before asking, then (2) poll real slots
    # 1..N individually — never the empty id-0 "all" query.
    et = EasyTouch(port="x")
    sched = _schedule_packet(1, 6, 8, 0, 10, 30, 0x2A).to_bytes(idle=2)
    et._serial = StubSerial(REAL_STATUS, sched)
    out = et.get_schedules(timeout=0.3)
    assert any(s.id == 1 and s.circuit == 6 for s in out)
    gets = [decode_frame(w) for w in et._serial.writes
            if decode_frame(w).cfi == C.Action.GET_SCHEDULE]
    assert gets, "should have polled at least one slot"
    assert gets[0].sub == 0x27                    # primed: first ask uses learned sub
    assert all(g.data[0] != 0 for g in gets)     # never the empty id-0 request
    assert gets[0].data[0] == 1                   # starts at real slot 1


def test_set_schedule_raises_timeout_on_silent_bus():
    # A confirmed write to a bus that never echoes the schedule back must give up
    # at the deadline (not block forever on an endless packet iterator).
    et = EasyTouch(port="x")
    et._serial = StubSerial()              # silent: read() always returns b""
    import pytest
    with pytest.raises(TimeoutError):
        et.set_schedule(1, 6, "08:00", "10:30", ["mon"], timeout=0.2)


def test_parse_hhmm_validation():
    import pytest
    assert _parse_hhmm("08:05") == (8, 5)
    with pytest.raises(ValueError):
        _parse_hhmm("8h05")
    with pytest.raises(ValueError):
        _parse_hhmm("24:00")
