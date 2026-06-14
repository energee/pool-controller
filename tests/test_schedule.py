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
from easytouch.protocol import decode as decode_frame


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
    pkt = et.build_get_schedules()
    frame = pkt.to_bytes(idle=2)
    back = decode_frame(frame)
    assert back.cfi == C.Action.GET_SCHEDULE
    assert back.dst == C.Address.MAIN
    assert back.data == bytes([0])


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


def test_parse_hhmm_validation():
    import pytest
    assert _parse_hhmm("08:05") == (8, 5)
    with pytest.raises(ValueError):
        _parse_hhmm("8h05")
    with pytest.raises(ValueError):
        _parse_hhmm("24:00")
