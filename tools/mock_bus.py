"""tools/mock_bus.py — a fake EasyTouch bus over TCP, for development without hardware.

Emits the same byte stream a real RS-485 bus would: A5 broadcasts (controller
status, date/time, pump) plus IntelliChlor DLE frames, and answers the requests
``BusMonitor`` makes (heat, schedules, version). Client writes — set-circuit,
set-heat, set-schedule, set-clock, set chlorinator output — mutate the in-memory
state and are echoed back, so the dashboard's controls confirm like real hardware.

Because ``--port`` already understands ``socket://HOST:PORT``, no PTY or socat is
involved::

    python tools/mock_bus.py &                                    # listens on 127.0.0.1:4000
    python -m easytouch --port socket://127.0.0.1:4000 serve --http-port 8080

``python tools/mock_bus.py --selftest`` round-trips the generated frames through
the real decoders and exits.
"""
from __future__ import annotations

import argparse
import socket
import time
from datetime import datetime, timedelta

from easytouch import constants as C
from easytouch.intellichlor import (
    IC_END,
    IC_START,
    ChlorinatorReader,
    ICAddress,
    ICCommand,
    build_set_output,
    ic_checksum,
)
from easytouch.protocol import Packet
from easytouch.reader import PacketReader

SUB = 0x27  # protocol sub-version the real controller stamps; clients learn it from us

# The whole simulated pool. Circuit numbers follow C.DEFAULT_CIRCUITS.
STATE = {
    "circuits": {1: False, 2: False, 6: True, 7: False},   # spa, aux1, pool, aux2
    "pool_temp": 83, "spa_temp": 83, "air_temp": 82, "solar_temp": 0,
    "pool_sp": 85, "spa_sp": 102, "heat_mode": 0x05,       # pool+spa = Heater
    "salt": 55, "chlor_pct": 40,                           # salt is in units of 50 ppm
    "clock_skew": timedelta(0),                            # set-clock writes land here
    # id -> (circuit, start_h, start_m, end_h, end_m, days_mask)
    "schedules": {1: (6, 8, 0, 17, 0, 0x7F), 2: (1, 18, 0, 21, 0, 0x41)},
}


def _now() -> datetime:
    return datetime.now() + STATE["clock_skew"]


def _equip() -> tuple[int, int, int]:
    """Pack the on-circuits into the three equipment bitmask bytes."""
    m = [0, 0, 0]
    for circuit, on in STATE["circuits"].items():
        if on and 1 <= circuit <= 24:
            m[(circuit - 1) // 8] |= 1 << ((circuit - 1) % 8)
    return m[0], m[1], m[2]


def _bcast(cfi: int, payload: bytes, src: int = C.Address.MAIN) -> Packet:
    return Packet(sub=SUB, dst=C.Address.BROADCAST, src=src, cfi=cfi, data=payload)


def status_pkt() -> Packet:
    """CFI 2 controller status. Payload index n == documented body offset n+6."""
    now = _now()
    p = bytearray(29)
    p[0], p[1] = now.hour, now.minute
    p[2], p[3], p[4] = _equip()
    p[9] = 0                                   # runmode: °F, not service, not freeze
    p[10] = 12                                 # valve actuator state
    p[14] = STATE["pool_temp"]
    p[15] = STATE["spa_temp"]
    # ponytail: heater is "on" whenever the pool is running below set-point. Good
    # enough to exercise the UI; model duty cycles only if you're testing them.
    p[16] = 0x20 if STATE["circuits"].get(6) and STATE["pool_temp"] < STATE["pool_sp"] else 0
    p[18] = STATE["air_temp"]
    p[19] = STATE["solar_temp"]
    p[22] = STATE["heat_mode"]
    return _bcast(C.Action.CONTROLLER_STATUS, bytes(p))


def datetime_pkt() -> Packet:
    now = _now()
    dow = 1 << ((now.weekday() + 1) % 7)       # Pentair weekday bit: Sun = 0x01
    return _bcast(C.Action.DATE_TIME, bytes([now.hour, now.minute, dow, now.day,
                                             now.month, now.year - 2000, 0, 1]))


def heat_pkt() -> Packet:
    p = bytearray(16)
    p[0], p[1], p[2] = STATE["pool_temp"], STATE["spa_temp"], STATE["air_temp"]
    p[3], p[4], p[5] = STATE["pool_sp"], STATE["spa_sp"], STATE["heat_mode"]
    p[9] = 100                                 # cool set-point "parked"
    return _bcast(C.Action.HEAT_STATUS, bytes(p))


def schedule_pkt(sched_id: int) -> Packet:
    circuit, sh, sm, eh, em, mask = STATE["schedules"].get(sched_id, (0, 0, 0, 0, 0, 0))
    return _bcast(C.Action.SCHEDULE, bytes([sched_id, circuit, sh, sm, eh, em, mask]))


def pump_pkt() -> Packet:
    running = STATE["circuits"].get(6) or STATE["circuits"].get(1)
    watts, rpm = (1250, 2750) if running else (0, 0)
    p = bytearray(15)
    p[0], p[1], p[2] = 0x0A, 0x00, 0x02
    p[3], p[4] = watts >> 8, watts & 0xFF
    p[5], p[6] = rpm >> 8, rpm & 0xFF
    p[13], p[14] = 3, 20                       # run time: 3h20m
    return Packet(sub=SUB, dst=C.Address.MAIN, src=C.Address.PUMP1,
                  cfi=C.Action.PUMP_STATUS, data=bytes(p))


def version_pkt() -> Packet:
    return _bcast(C.Action.SW_VERSION, bytes([2, 80]))


def chlor_status_frame() -> bytes:
    """IntelliChlor salt status: ``10 02 00 12 <salt> <flags> <chk> 10 03``."""
    body = IC_START + bytes([ICAddress.CONTROLLER, ICCommand.STATUS, STATE["salt"], 0x80])
    return body + bytes([ic_checksum(body)]) + IC_END


def handle_packet(pkt: Packet) -> list[Packet]:
    """Apply a client command / answer a request; returns packets to send back."""
    d = pkt.data
    if pkt.cfi == C.Action.SET_CIRCUIT and len(d) >= 2:
        STATE["circuits"][d[0]] = bool(d[1])
        return [status_pkt()]
    if pkt.cfi == C.Action.SET_HEAT and len(d) >= 3:
        STATE["pool_sp"], STATE["spa_sp"], STATE["heat_mode"] = d[0], d[1], d[2]
        return [heat_pkt(), status_pkt()]
    if pkt.cfi == C.Action.SET_SCHEDULE and len(d) >= 7:
        STATE["schedules"][d[0]] = (d[1], d[2], d[3], d[4], d[5], d[6])
        return [schedule_pkt(d[0])]
    if pkt.cfi == C.Action.SET_DATETIME and len(d) >= 6:
        want = datetime(2000 + d[5], d[4], d[3], d[0], d[1])
        STATE["clock_skew"] = want - datetime.now()
        return [datetime_pkt(), status_pkt()]
    if pkt.cfi == C.Action.GET_HEAT:
        return [heat_pkt()]
    if pkt.cfi == C.Action.GET_SCHEDULE and d:
        return [schedule_pkt(d[0])]
    if pkt.cfi == C.Action.GET_VERSION:
        return [version_pkt()]
    if pkt.cfi == C.Action.GET_STATUS:
        return [status_pkt()]
    return []                                  # lights, pumps, anything else: swallowed


def serve_client(conn: socket.socket) -> None:
    a5, ic = PacketReader(), ChlorinatorReader()
    conn.settimeout(0.2)
    next_at = {"status": 0.0, "datetime": 0.0, "pump": 0.0, "chlor": 0.0}
    every = {"status": 2.0, "datetime": 5.0, "pump": 3.0, "chlor": 4.0}
    while True:
        try:
            chunk = conn.recv(1024)
            if not chunk:
                return                         # client hung up
        except socket.timeout:
            chunk = b""
        for pkt in a5.feed(chunk):
            for reply in handle_packet(pkt):
                conn.sendall(reply.to_bytes())
        for frame in ic.feed(chunk):
            if frame.cmd == ICCommand.SET_OUTPUT and frame.data:
                STATE["chlor_pct"] = frame.data[0]
                conn.sendall(build_set_output(STATE["chlor_pct"]))

        now = time.monotonic()
        for key, period in every.items():
            if now < next_at[key]:
                continue
            next_at[key] = now + period
            if key == "status":
                conn.sendall(status_pkt().to_bytes())
            elif key == "datetime":
                conn.sendall(datetime_pkt().to_bytes())
            elif key == "pump":
                conn.sendall(pump_pkt().to_bytes())
            else:
                conn.sendall(chlor_status_frame() + build_set_output(STATE["chlor_pct"]))


def selftest() -> None:
    """Round-trip every generated frame through the real framer + decoders."""
    from easytouch.decode import (ControllerStatus, DateTime, HeatStatus, PumpStatus,
                                 Schedule, decode)
    from easytouch.intellichlor import ChlorinatorStatus, decode_ic

    reader = PacketReader()
    pkts = [status_pkt(), datetime_pkt(), heat_pkt(), schedule_pkt(1), pump_pkt()]
    decoded = [decode(p) for pkt in pkts for p in reader.feed(pkt.to_bytes())]
    s, dt, h, sched, pump = decoded
    assert isinstance(s, ControllerStatus) and s.circuits_on == [6], s
    assert s.pool_temp == 83 and s.heater_on is True, s
    assert isinstance(dt, DateTime) and dt.hour == datetime.now().hour, dt
    assert isinstance(h, HeatStatus) and (h.pool_setpoint, h.spa_setpoint) == (85, 102), h
    assert isinstance(sched, Schedule) and sched.start == "08:00" and sched.end == "17:00", sched
    assert isinstance(pump, PumpStatus) and pump.rpm == 2750, pump

    ic = ChlorinatorReader()
    (frame,) = ic.feed(chlor_status_frame())
    chlor = decode_ic(frame)
    assert isinstance(chlor, ChlorinatorStatus) and chlor.salt_ppm == 2750, chlor

    handle_packet(Packet(SUB, C.Address.MAIN, C.Address.REMOTE, C.Action.SET_CIRCUIT, b"\x01\x01"))
    assert decode(next(iter(reader.feed(status_pkt().to_bytes())))).circuits_on == [1, 6]
    print("mock_bus selftest OK")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=4000)
    ap.add_argument("--selftest", action="store_true", help="verify frames decode, then exit")
    args = ap.parse_args()
    if args.selftest:
        return selftest()

    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((args.host, args.port))
    srv.listen(1)                              # the real bus has one usable connection
    print(f"mock bus on socket://{args.host}:{args.port} (Ctrl-C to stop)")
    while True:
        conn, addr = srv.accept()
        print(f"  client {addr[0]}:{addr[1]} connected")
        try:
            serve_client(conn)
        except (ConnectionError, OSError) as exc:
            print(f"  client gone: {exc}")
        finally:
            conn.close()


if __name__ == "__main__":
    main()
