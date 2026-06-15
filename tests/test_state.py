"""Tests for the BusMonitor — the single owner of the serial connection.

These drive the monitor synchronously via ``_poll_once`` (one read → ingest →
refresh → drain cycle) with a StubSerial, so no real thread or bus is needed.
"""
from __future__ import annotations

import json

import pytest

from easytouch import constants as C
from easytouch.protocol import Packet
from easytouch.protocol import parse_frame as decode_frame
from easytouch.state import BusMonitor

from stub_serial import StubSerial

REAL_STATUS = bytes.fromhex(
    "00ffa5270f10021d0b0120000000000000200c000004535320005200000005000097a6030d03d0"
)


def _heat_frame(pool_sp=0x54, spa_sp=0x46, mode=0x05) -> bytes:
    data = bytearray([0x54, 0x54, 0x55, 0x54, 0x46, 0x05, 0, 0, 0, 0x64, 0, 0, 0])
    data[3], data[4], data[5] = pool_sp, spa_sp, mode
    return Packet(sub=0x27, dst=C.Address.BROADCAST, src=C.Address.MAIN,
                  cfi=C.Action.HEAT_STATUS, data=bytes(data)).to_bytes(idle=2)


def _sched_frame(sid=1, circ=6) -> bytes:
    return Packet(sub=0x27, dst=C.Address.BROADCAST, src=C.Address.MAIN,
                  cfi=C.Action.SCHEDULE,
                  data=bytes([sid, circ, 8, 0, 10, 30, 0x2A])).to_bytes(idle=2)


def _sent(stub) -> list:
    return [decode_frame(w) for w in stub.writes]


def test_ingests_controller_status():
    mon = BusMonitor("x")
    mon._et._serial = StubSerial(REAL_STATUS)
    mon._poll_once()
    st = mon.get_state()
    assert st["status"]["clock"] == "11:01"
    assert st["status"]["circuits_on"] == [6]
    assert st["status"]["unit"] == "F"
    assert st["connected"] is True
    assert st["last_packet_ts"] is not None
    assert C.Action.CONTROLLER_STATUS in st["raw"]


def test_ingests_heat_and_schedule():
    mon = BusMonitor("x")
    mon._et._serial = StubSerial(_heat_frame() + _sched_frame())
    mon._poll_once()
    st = mon.get_state()
    assert st["heat"]["pool_setpoint"] == 84
    assert st["heat"]["spa_setpoint"] == 70
    assert st["schedules"][1]["circuit"] == 6
    assert st["schedules"][1]["circuit_name"] == "pool"


def test_ingests_chlorinator_salt():
    # Salt rides the IntelliChlor native protocol (10 02 .. 10 03), not A5, so the
    # monitor must frame it with a second reader over the same byte stream.
    salt_status = bytes.fromhex("100200123780db1003")   # real bytes: 2750 ppm
    mon = BusMonitor("x")
    mon._et._serial = StubSerial(salt_status)
    mon._poll_once()
    st = mon.get_state()
    assert st["chlorinator"]["salt_ppm"] == 2750
    assert st["chlorinator"]["status_flags"] == 0x80


def test_chlorinator_state_includes_last_seen_age():
    # The UI needs to show staleness instead of vanishing, so chlorinator state
    # carries a last-seen timestamp and an age once an IC frame has arrived.
    salt_status = bytes.fromhex("100200123780db1003")   # real bytes: 2750 ppm
    mon = BusMonitor("x")
    mon._et._serial = StubSerial(salt_status)
    mon._poll_once()
    c = mon.get_state()["chlorinator"]
    assert c["salt_ppm"] == 2750
    assert c["last_seen_ts"] is not None
    assert isinstance(c["age"], float) and c["age"] >= 0


def test_chlorinator_absent_when_only_a5_traffic():
    # A5 status frames embed 10 02; the hardened IC framer must not manufacture a
    # phantom chlorinator entry from them — no IC frame, no chlorinator section.
    mon = BusMonitor("x")
    mon._et._serial = StubSerial(REAL_STATUS)
    mon._poll_once()
    assert mon.get_state()["chlorinator"] is None


def test_state_is_json_serializable():
    mon = BusMonitor("x")
    mon._et._serial = StubSerial(REAL_STATUS + _heat_frame())
    mon._poll_once()
    blob = json.dumps(mon.get_state())
    assert '"clock": "11:01"' in blob


def test_set_circuit_enqueues_and_sends_on_poll():
    mon = BusMonitor("x")
    stub = StubSerial()
    mon._et._serial = stub
    mon.set_circuit(1, True)
    mon._poll_once()                      # drains the command queue
    setc = [p for p in _sent(stub) if p.cfi == C.Action.SET_CIRCUIT]
    assert len(setc) == 1
    assert setc[0].data == bytes([1, 1])


def test_set_heat_uses_cached_heat_for_read_modify_write():
    mon = BusMonitor("x")
    mon._et._serial = StubSerial(_heat_frame(pool_sp=84, spa_sp=70, mode=5))
    mon._poll_once()                      # populate cached heat
    mon.set_heat(pool_setpoint=85)
    mon._poll_once()                      # drain -> send
    seth = [p for p in _sent(mon._et._serial) if p.cfi == C.Action.SET_HEAT]
    assert seth and seth[-1].data == bytes([85, 70, 5, 0])


def test_set_heat_also_requests_fresh_read_for_confirmation():
    # Heat status is never broadcast unsolicited, so after a write the monitor must
    # re-request it (Get-Heat) — otherwise confirmation matches a stale cache.
    mon = BusMonitor("x")
    mon._et._serial = StubSerial(_heat_frame(pool_sp=84, spa_sp=70, mode=5))
    mon._poll_once()                      # cache heat + prime the sub
    mon._et._serial.writes.clear()        # ignore the initial refresh
    mon.set_heat(pool_setpoint=85)
    mon._poll_once()
    cfis = [decode_frame(w).cfi for w in mon._et._serial.writes]
    assert C.Action.SET_HEAT in cfis
    assert C.Action.GET_HEAT in cfis
    assert cfis.index(C.Action.SET_HEAT) < cfis.index(C.Action.GET_HEAT)


def test_set_heat_re_requests_heat_across_multiple_polls():
    # One follow-up read can race the controller (it may answer before applying the
    # write), so a Set must keep re-requesting across the confirm window.
    mon = BusMonitor("x")
    mon._et._serial = StubSerial(_heat_frame())
    mon._poll_once()                      # prime
    mon.set_heat(pool_setpoint=85)
    counts = []
    for _ in range(3):
        mon._et._serial.writes.clear()
        mon._poll_once()
        counts.append(sum(1 for w in mon._et._serial.writes
                          if decode_frame(w).cfi == C.Action.GET_HEAT))
    assert all(c >= 1 for c in counts)    # re-requested on each of several polls


def test_set_schedule_accepts_string_days_from_api():
    # The HTTP API/webapp pass `days` as a string ("every", "mon,wed,fri"); the
    # monitor must encode it without raising (regression: POST /schedule -> 400).
    mon = BusMonitor("x")
    mon._et._serial = StubSerial(REAL_STATUS)   # prime the sub
    mon._poll_once()
    mon._et._serial.writes.clear()
    mon.set_schedule(2, 6, "08:00", "10:30", "mon,wed,fri")
    mon._poll_once()                             # drain -> send
    setp = [p for p in _sent(mon._et._serial) if p.cfi == C.Action.SET_SCHEDULE]
    assert setp, "a Set-Schedule frame should have been sent"
    assert setp[-1].data[0] == 2                 # slot id
    assert setp[-1].data[6] == 0x2A              # mon,wed,fri day mask


def test_set_schedule_also_requests_fresh_read():
    mon = BusMonitor("x")
    mon._et._serial = StubSerial(REAL_STATUS)   # prime the sub
    mon._poll_once()
    mon._et._serial.writes.clear()
    mon.set_schedule(1, 6, "08:00", "10:30", ["mon"])
    mon._poll_once()
    cfis = [decode_frame(w).cfi for w in mon._et._serial.writes]
    assert C.Action.SET_SCHEDULE in cfis
    assert C.Action.GET_SCHEDULE in cfis


def test_set_heat_without_cached_heat_raises():
    mon = BusMonitor("x")
    mon._et._serial = StubSerial()
    with pytest.raises(RuntimeError):
        mon.set_heat(pool_setpoint=85)


def test_wait_for_returns_state_when_condition_met():
    mon = BusMonitor("x")
    mon._et._serial = StubSerial(REAL_STATUS)
    mon._poll_once()
    st = mon.wait_for(lambda s: s["status"] is not None, timeout=0.5)
    assert st is not None and st["status"]["circuits_on"] == [6]


def test_wait_for_times_out_to_none():
    mon = BusMonitor("x")
    mon._et._serial = StubSerial()
    assert mon.wait_for(lambda s: s["status"] is not None, timeout=0.2) is None


def test_refresh_waits_until_controller_sub_is_learned():
    # The controller ignores requests sent with the default sub; the monitor must
    # not fire Get-Heat/Get-Schedule until it has learned the real sub (0x27) from
    # a controller packet — otherwise the very first refresh is wasted.
    mon = BusMonitor("x")
    silent = StubSerial()
    mon._et._serial = silent
    mon._poll_once()                       # nothing learned yet -> no refresh sent
    assert silent.writes == []
    mon._et._serial = StubSerial(REAL_STATUS)
    mon._poll_once()                       # status primes the learned sub
    sent = [decode_frame(w) for w in mon._et._serial.writes]
    assert any(p.cfi == C.Action.GET_HEAT for p in sent)
    assert sent and all(p.sub == 0x27 for p in sent)


def test_refresh_scans_every_schedule_slot_one_at_a_time():
    # The controller answers Get-Schedule only for the slot id in the request (id 0
    # is always empty) AND drops a burst of requests, so the monitor must poll every
    # slot 1..N, one per poll cycle — never all at once. Otherwise real schedules in
    # slots 1..N never reach the cache (and the webapp).
    from easytouch.state import SCHEDULE_SLOTS

    mon = BusMonitor("x")
    mon._sched_req_gap = 0.0                     # disable pacing for a deterministic test
    mon._et._serial = StubSerial(REAL_STATUS)   # primes the learned sub
    requested, per_poll = [], []
    for _ in range(SCHEDULE_SLOTS + 2):
        mon._et._serial.writes.clear()
        mon._poll_once()
        gets = [p for p in _sent(mon._et._serial) if p.cfi == C.Action.GET_SCHEDULE]
        per_poll.append(len(gets))
        requested += [g.data[0] for g in gets]
    assert max(per_poll) == 1                    # one slot per poll — never a burst
    assert sorted(set(requested)) == list(range(1, SCHEDULE_SLOTS + 1))
    assert 0 not in requested                    # the empty id-0 request is gone


def test_package_exports_full_api_surface():
    import easytouch
    from easytouch import BusMonitor as BM, HeatStatus, decode_heat_status, serve
    assert BM is BusMonitor
    for name in ("BusMonitor", "HeatStatus", "decode_heat_status", "serve"):
        assert name in easytouch.__all__


def test_set_chlorinator_output_enqueues_raw_ic_frame():
    from easytouch.intellichlor import ChlorinatorReader, decode_ic
    mon = BusMonitor("x")
    stub = StubSerial()
    mon._et._serial = stub
    assert mon.set_chlorinator_output(45) == 45
    mon._poll_once()                               # drains the command queue
    frames = ChlorinatorReader().feed(b"".join(stub.writes))
    assert frames and decode_ic(frames[0]).output_percent == 45
    assert mon.get_state()["chlorinator"]["output_percent"] == 45   # optimistic cache
