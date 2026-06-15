"""
easytouch.cli — command-line interface for the EasyTouch bus.

Subcommands::

    easytouch monitor      stream decoded bus traffic
    easytouch status       print one decoded system snapshot as a table
    easytouch json         print one snapshot as JSON (good for scripting)
    easytouch on  <circ>   turn a circuit on  (name or number)
    easytouch off <circ>   turn a circuit off
    easytouch schedules    view stored schedules
    easytouch set-schedule write a schedule slot
    easytouch heat         print heat/temperature status
    easytouch set-heat     set heat set-points and/or modes
    easytouch set-chlor    set IntelliChlor generation output %
    easytouch set-clock    set the controller clock (default: now)
    easytouch serve        run the HTTP JSON API (owns the bus)
    easytouch raw          dump raw hex frames (debugging)

Run ``python -m easytouch --help`` for the full option list. ``--port`` defaults
to ``/tmp/vserial``.
"""
from __future__ import annotations

import argparse
import json
import sys
import time

from . import constants as C
from .controller import DEFAULT_BAUD, DEFAULT_PORT, EasyTouch, resolve_circuit
from .decode import ControllerStatus, decode


def _status_dict(s: ControllerStatus) -> dict:
    return {
        "clock": s.clock,
        "circuits_on": s.circuits_on,
        "circuit_names": s.circuit_names,
        "pool_temp": s.pool_temp,
        "spa_temp": s.spa_temp,
        "air_temp": s.air_temp,
        "solar_temp": s.solar_temp,
        "unit": s.unit,
        "heater_on": s.heater_on,
        "pool_heat_mode": s.pool_heat_mode,
        "spa_heat_mode": s.spa_heat_mode,
        "service": s.service,
        "freeze": s.freeze,
    }


def _print_status(s: ControllerStatus) -> None:
    circuits = ", ".join(s.circuit_names) if s.circuit_names else "(all off)"
    print(f"  Clock        : {s.clock}")
    print(f"  Circuits on  : {circuits}  {s.circuits_on}")
    print(f"  Pool temp    : {s.pool_temp}°{s.unit}")
    print(f"  Spa temp     : {s.spa_temp}°{s.unit}")
    print(f"  Air temp     : {s.air_temp}°{s.unit}")
    print(f"  Solar temp   : {s.solar_temp}°{s.unit}")
    print(f"  Heater       : {'ON' if s.heater_on else 'off'}")
    print(f"  Heat mode    : pool={s.pool_heat_mode}  spa={s.spa_heat_mode}")
    if s.service:
        print("  Mode         : SERVICE")
    if s.freeze:
        print("  Freeze       : ACTIVE")


def cmd_monitor(et: EasyTouch, args) -> int:
    print(f"Monitoring {args.port} (Ctrl-C to stop)...")
    deadline = time.monotonic() + args.seconds if args.seconds else None
    for pkt in et.packets():
        decoded = decode(pkt)
        ts = time.strftime("%H:%M:%S")
        cls = type(decoded).__name__
        if cls == "Unknown":
            print(f"[{ts}] {pkt}")
        else:
            print(f"[{ts}] {cls}: {decoded}")
        if deadline and time.monotonic() > deadline:
            break
    return 0


def cmd_raw(et: EasyTouch, args) -> int:
    print(f"Raw frames on {args.port} (Ctrl-C to stop)...")
    deadline = time.monotonic() + args.seconds if args.seconds else None
    for pkt in et.packets():
        print(pkt.to_bytes(idle=0).hex())
        if deadline and time.monotonic() > deadline:
            break
    return 0


def cmd_status(et: EasyTouch, args) -> int:
    s = et.snapshot(timeout=args.timeout)
    print(f"EasyTouch status @ {args.port}:")
    _print_status(s)
    return 0


def cmd_json(et: EasyTouch, args) -> int:
    s = et.snapshot(timeout=args.timeout)
    print(json.dumps(_status_dict(s), indent=2))
    return 0


def _print_schedules(scheds) -> None:
    active = [s for s in scheds if s.active]
    if not active:
        print("  (all schedule slots are empty)")
        return
    print(f"  {'ID':>2}  {'Circuit':<10} {'Start':>5} {'Stop':>5}  Days")
    for s in active:
        days = ", ".join(s.days) if s.days else "-"
        print(f"  {s.id:>2}  {s.circuit_name:<10} {s.start:>5} {s.end:>5}  {days}")


def cmd_schedules(et: EasyTouch, args) -> int:
    print(f"Fetching schedules from {args.port} (timeout {args.timeout:g}s)...")
    scheds = et.get_schedules(timeout=args.timeout)
    if not scheds:
        print("No schedules received. (This endpoint may not serve schedules — "
              "the status-only simulator does not.)")
        return 0
    _print_schedules(scheds)
    return 0


def cmd_set_schedule(et: EasyTouch, args) -> int:
    circuit = resolve_circuit(args.circuit)
    days = [d for d in args.days.split(",") if d.strip()] if args.days else []
    print(f"Setting schedule #{args.id}: {C.circuit_label(circuit)} "
          f"{args.start}-{args.end} days={args.days or 'none'}...")
    sched = et.set_schedule(args.id, circuit, args.start, args.end, days,
                            confirm=not args.no_confirm, timeout=args.timeout)
    if sched is None:
        print("Command sent (not confirmed).")
        return 0
    _print_schedules([sched])
    print(f"Confirmed schedule #{sched.id}.")
    return 0


# Heat-mode name → code (0-3). The shared heat byte packs pool (bits 0-1) and
# spa (bits 2-3) modes; CLI accepts friendly names or the raw 0-3.
_HEAT_MODE_ALIASES = {
    "off": 0, "0": 0,
    "heater": 1, "heat": 1, "1": 1,
    "solar": 2, "solar pref": 2, "solarpref": 2, "2": 2,
    "solar only": 3, "solaronly": 3, "3": 3,
}


def resolve_heat_mode(token) -> int:
    """Map a heat-mode name (off/heater/solar/solar-only) or 0-3 to its code."""
    key = str(token).strip().lower().replace("-", " ").replace("_", " ")
    if key in _HEAT_MODE_ALIASES:
        return _HEAT_MODE_ALIASES[key]
    if key.replace(" ", "") in _HEAT_MODE_ALIASES:
        return _HEAT_MODE_ALIASES[key.replace(" ", "")]
    raise ValueError(f"unknown heat mode: {token!r} (use off/heater/solar/solar-only or 0-3)")


def _print_heat(hs) -> None:
    print(f"  Pool temp     : {hs.pool_temp}°")
    print(f"  Spa temp      : {hs.spa_temp}°")
    print(f"  Air temp      : {hs.air_temp}°")
    print(f"  Pool setpoint : {hs.pool_setpoint}°  (mode: {hs.pool_heat_mode})")
    print(f"  Spa setpoint  : {hs.spa_setpoint}°  (mode: {hs.spa_heat_mode})")


def cmd_heat(et: EasyTouch, args) -> int:
    hs = et.get_heat(timeout=args.timeout)
    print(f"EasyTouch heat @ {args.port}:")
    _print_heat(hs)
    return 0


def cmd_set_heat(et: EasyTouch, args) -> int:
    pool_mode = resolve_heat_mode(args.pool_mode) if args.pool_mode is not None else None
    spa_mode = resolve_heat_mode(args.spa_mode) if args.spa_mode is not None else None
    if args.pool is None and args.spa is None and pool_mode is None and spa_mode is None:
        print("nothing to set; pass --pool/--spa/--pool-mode/--spa-mode", file=sys.stderr)
        return 2
    hs = et.set_heat(pool_setpoint=args.pool, spa_setpoint=args.spa,
                     pool_mode=pool_mode, spa_mode=spa_mode,
                     confirm=not args.no_confirm, timeout=args.timeout)
    if hs is None:
        print("Set-Heat sent (not confirmed).")
        return 0
    _print_heat(hs)
    print("Confirmed.")
    return 0


def cmd_set_clock(et: EasyTouch, args) -> int:
    import datetime as dt
    when = dt.datetime.fromisoformat(args.iso) if args.iso else None
    res = et.set_datetime(when, confirm=not args.no_confirm, timeout=args.timeout)
    if res is None:
        print("Set-Clock sent (not confirmed).")
        return 0
    print(f"Confirmed controller clock: {res.iso}")
    return 0


def cmd_set_chlor(et: EasyTouch, args) -> int:
    from .intellichlor import build_set_output
    pct = max(0, min(100, args.percent))
    et.send_raw(build_set_output(pct))
    print(f"Sent IntelliChlor output {pct}% to {args.port}.")
    print("Note: a present EasyTouch controller may override this on its next cycle.")
    return 0


def cmd_serve(args) -> int:
    """Run the HTTP API. Unlike other commands this owns the bus via a BusMonitor,
    so it must NOT be wrapped in the shared per-request EasyTouch connection."""
    from .api import serve
    serve(port=args.port, baud=args.baud, address=args.address,
          http_host=args.http_host, http_port=args.http_port)
    return 0


def _set(et: EasyTouch, args, on: bool) -> int:
    circuit = resolve_circuit(args.circuit)
    label = C.circuit_label(circuit)
    print(f"Setting {label} (circuit {circuit}) -> {'ON' if on else 'OFF'}...")
    status = et.set_circuit(circuit, on, confirm=not args.no_confirm, timeout=args.timeout)
    if status is None:
        print("Command sent (not confirmed).")
        return 0
    ok = (circuit in status.circuits_on) == on
    _print_status(status)
    if ok:
        print(f"Confirmed: {label} is {'ON' if on else 'OFF'}.")
        return 0
    print(f"WARNING: {label} did not reach requested state.", file=sys.stderr)
    return 1


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="easytouch", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", default=DEFAULT_PORT, help=f"serial port (default {DEFAULT_PORT})")
    p.add_argument("--baud", type=int, default=DEFAULT_BAUD, help="baud rate (default 9600)")
    p.add_argument("--address", type=lambda x: int(x, 0), default=C.Address.REMOTE,
                   help="bus address to send from (default 0x20)")
    sub = p.add_subparsers(dest="command", required=True)

    m = sub.add_parser("monitor", help="stream decoded packets")
    m.add_argument("--seconds", type=float, default=0, help="stop after N seconds (0 = forever)")
    m.set_defaults(func=cmd_monitor)

    r = sub.add_parser("raw", help="dump raw hex frames")
    r.add_argument("--seconds", type=float, default=0, help="stop after N seconds (0 = forever)")
    r.set_defaults(func=cmd_raw)

    st = sub.add_parser("status", help="print one decoded snapshot")
    st.add_argument("--timeout", type=float, default=10.0)
    st.set_defaults(func=cmd_status)

    js = sub.add_parser("json", help="print one snapshot as JSON")
    js.add_argument("--timeout", type=float, default=10.0)
    js.set_defaults(func=cmd_json)

    on = sub.add_parser("on", help="turn a circuit on")
    on.add_argument("circuit", help="circuit name (pool, spa, aux1...) or number")
    on.add_argument("--timeout", type=float, default=6.0)
    on.add_argument("--no-confirm", action="store_true", help="fire and forget")
    on.set_defaults(func=lambda et, a: _set(et, a, True))

    off = sub.add_parser("off", help="turn a circuit off")
    off.add_argument("circuit", help="circuit name (pool, spa, aux1...) or number")
    off.add_argument("--timeout", type=float, default=6.0)
    off.add_argument("--no-confirm", action="store_true", help="fire and forget")
    off.set_defaults(func=lambda et, a: _set(et, a, False))

    sc = sub.add_parser("schedules", help="view stored schedules")
    sc.add_argument("--timeout", type=float, default=6.0)
    sc.set_defaults(func=cmd_schedules)

    ss = sub.add_parser("set-schedule", help="write a schedule slot")
    ss.add_argument("--id", type=int, required=True, help="schedule slot id (e.g. 1-12)")
    ss.add_argument("--circuit", required=True, help="circuit name (pool, spa...) or number")
    ss.add_argument("--start", required=True, help="start time HH:MM")
    ss.add_argument("--end", required=True, help="end time HH:MM")
    ss.add_argument("--days", default="every",
                    help="comma list (mon,wed,fri), or weekdays/weekends/every")
    ss.add_argument("--timeout", type=float, default=8.0)
    ss.add_argument("--no-confirm", action="store_true", help="fire and forget")
    ss.set_defaults(func=cmd_set_schedule)

    hp = sub.add_parser("heat", help="print heat/temperature status")
    hp.add_argument("--timeout", type=float, default=8.0)
    hp.set_defaults(func=cmd_heat)

    sh = sub.add_parser("set-heat", help="set heat set-points and/or modes")
    sh.add_argument("--pool", type=int, help="pool set-point in degrees")
    sh.add_argument("--spa", type=int, help="spa set-point in degrees")
    sh.add_argument("--pool-mode", help="pool heat mode (off/heater/solar/solar-only or 0-3)")
    sh.add_argument("--spa-mode", help="spa heat mode (off/heater/solar/solar-only or 0-3)")
    sh.add_argument("--timeout", type=float, default=8.0)
    sh.add_argument("--no-confirm", action="store_true", help="fire and forget")
    sh.set_defaults(func=cmd_set_heat)

    chl = sub.add_parser("set-chlor", help="set IntelliChlor generation output percent")
    chl.add_argument("--percent", type=int, required=True, help="output percent 0-100")
    chl.set_defaults(func=cmd_set_chlor)

    sk = sub.add_parser("set-clock", help="set the controller clock (default: now)")
    sk.add_argument("--iso", help="ISO datetime, e.g. 2026-06-14T11:30 (default: now)")
    sk.add_argument("--timeout", type=float, default=8.0)
    sk.add_argument("--no-confirm", action="store_true", help="fire and forget")
    sk.set_defaults(func=cmd_set_clock)

    sv = sub.add_parser("serve", help="run the HTTP JSON API (owns the bus)")
    sv.add_argument("--http-host", default="0.0.0.0", help="HTTP bind host (default 0.0.0.0)")
    sv.add_argument("--http-port", type=int, default=8080, help="HTTP port (default 8080)")
    sv.set_defaults(func=cmd_serve)

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    # `serve` owns the bus through a BusMonitor for its whole lifetime, so it must
    # not open the shared per-request EasyTouch connection the other commands use.
    if args.command == "serve":
        try:
            return cmd_serve(args)
        except KeyboardInterrupt:
            print()
            return 130
        except (OSError, ValueError) as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
    try:
        with EasyTouch(port=args.port, baud=args.baud, address=args.address) as et:
            return args.func(et, args)
    except KeyboardInterrupt:
        print()
        return 130
    except (TimeoutError, OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
