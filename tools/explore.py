"""
easytouch.explore — field reverse-engineering for A5 broadcasts.

A diagnostic tool for working out what the *undecoded* payload bytes mean. It
captures live packets and reports, per payload-byte index, which values were
observed and which bytes changed — so an operator can toggle one piece of
equipment at a time (a valve, a heat mode, solar) and watch exactly which byte
moves.

Two modes:

* ``survey`` — collect frames for a fixed window and print, per CFI, a table of
  every payload byte: its reference label (if known), how many distinct values
  it took, and the values themselves. Constant bytes are likely reserved; bytes
  that vary on their own are live state.
* ``watch`` — print a running diff against the first frame seen for each CFI.
  Flip one thing on the panel and the byte that represents it lights up.

Known field labels come from ``PACKET_SPEC.txt`` (michaelusner, EasyTouch) and
tagyoureit/nodejs-poolController, expressed here as *payload* index (body
offset − 6) to match :attr:`Packet.data`. Anything without a label is printed as
``?`` — those are the bytes still to crack.

Usage::

    python tools/explore.py survey --port socket://192.168.4.70:4000 --seconds 30
    python tools/explore.py watch  --port socket://192.168.4.70:4000 --cfi 2
"""
from __future__ import annotations

import argparse
import time
from collections import defaultdict

from easytouch import constants as C
from easytouch.controller import EasyTouch

# Reference field maps, keyed by CFI then *payload* index (= body offset − 6).
# Sourced from PACKET_SPEC.txt (EasyTouch) and nodejs-poolController. A missing
# index means "no documented meaning yet" — the targets to crack.
REF_FIELDS: dict[int, dict[int, str]] = {
    C.Action.CONTROLLER_STATUS: {
        0: "hour", 1: "min", 2: "equip1", 3: "equip2", 4: "equip3",
        9: "runmode/UOM", 10: "valve", 12: "delay", 13: "heat?",
        14: "poolTemp", 15: "spaTemp", 16: "heaterActive",
        18: "airTemp", 19: "solarTemp", 22: "heatMode", 26: "autoDST",
    },
    C.Action.HEAT_STATUS: {
        0: "poolTemp", 1: "spaTemp", 2: "airTemp",
        3: "poolSetpt", 4: "spaSetpt", 5: "heatMode", 9: "coolSetpt",
    },
    C.Action.PUMP_STATUS: {
        0: "cmd", 1: "mode", 2: "driveState", 3: "wattsH", 4: "wattsL",
        5: "rpmH", 6: "rpmL", 7: "gpm", 8: "ppc", 9: "err",
        12: "timer", 13: "runHour", 14: "runMin",
    },
    C.Action.DATE_TIME: {
        0: "hour", 1: "min", 2: "dow", 3: "day", 4: "month", 5: "year",
        6: "autoDST?", 7: "autoDST?",
    },
    C.Action.SCHEDULE: {
        0: "id", 1: "circuit", 2: "startH", 3: "startM",
        4: "stopH", 5: "stopM", 6: "days",
    },
}


class FieldTracker:
    """Accumulates payloads for one (CFI, source) stream and tracks variation.

    Records, per payload-byte index, the set of values seen, the number of times
    the byte changed between consecutive frames, and the most recent value. The
    first payload becomes the ``baseline`` used by :meth:`diff`.
    """

    def __init__(self) -> None:
        self.frames = 0
        self.values: dict[int, set[int]] = defaultdict(set)
        self.changes: dict[int, int] = defaultdict(int)
        self.last: dict[int, int] = {}
        self.baseline: bytes | None = None

    def feed(self, data: bytes) -> None:
        self.frames += 1
        if self.baseline is None:
            self.baseline = bytes(data)
        for i, v in enumerate(data):
            if i in self.last and self.last[i] != v:
                self.changes[i] += 1
            self.last[i] = v
            self.values[i].add(v)

    def diff(self, data: bytes) -> list[tuple[int, int | None, int]]:
        """Return ``(index, baseline_value, new_value)`` for bytes != baseline."""
        base = self.baseline or b""
        out: list[tuple[int, int | None, int]] = []
        for i, v in enumerate(data):
            b = base[i] if i < len(base) else None
            if b != v:
                out.append((i, b, v))
        return out


def _label(cfi: int, idx: int) -> str:
    return REF_FIELDS.get(cfi, {}).get(idx, "?")


def _render_survey(trackers: dict[tuple[int, int], FieldTracker]) -> str:
    lines: list[str] = []
    for (cfi, src), t in sorted(trackers.items()):
        name = C.action_name(cfi, is_pump=C.is_pump(src))
        lines.append(
            f"\n=== CFI {cfi} ({name}) from {C.address_name(src)} "
            f"— {t.frames} frame(s) ==="
        )
        lines.append(f"{'idx':>3}  {'label':<13} {'chg':>3} {'#vals':>5}  values")
        for i in sorted(t.values):
            vals = sorted(t.values[i])
            shown = " ".join(f"{v:02x}" for v in vals[:8])
            if len(vals) > 8:
                shown += " …"
            flag = "  <-- varies" if len(vals) > 1 else ""
            lines.append(
                f"{i:>3}  {_label(cfi, i):<13} {t.changes[i]:>3} "
                f"{len(vals):>5}  {shown}{flag}"
            )
    return "\n".join(lines) if lines else "(no packets captured)"


def survey(et: EasyTouch, seconds: float, cfis: set[int] | None, poll: bool) -> str:
    """Capture for ``seconds`` and return a per-CFI byte-variation table."""
    trackers: dict[tuple[int, int], FieldTracker] = defaultdict(FieldTracker)
    deadline = time.monotonic() + seconds
    next_poll = 0.0
    while time.monotonic() < deadline:
        if poll and time.monotonic() >= next_poll:
            et.send(et.build_get_heat())
            et.send(et.build_get_schedules())
            next_poll = time.monotonic() + 3.0
        for pkt in et._iter_until(min(deadline, time.monotonic() + 1.0)):
            if cfis is None or pkt.cfi in cfis:
                trackers[(pkt.cfi, pkt.src)].feed(pkt.data)
    return _render_survey(trackers)


def watch(et: EasyTouch, cfis: set[int] | None) -> None:
    """Print a live diff against the first frame seen for each (CFI, src)."""
    trackers: dict[tuple[int, int], FieldTracker] = defaultdict(FieldTracker)
    print("watching — change one thing on the panel; Ctrl-C to stop\n")
    for pkt in et.packets():
        if cfis is not None and pkt.cfi not in cfis:
            continue
        t = trackers[(pkt.cfi, pkt.src)]
        if t.baseline is None:
            t.feed(pkt.data)
            print(f"baseline CFI {pkt.cfi} from {C.address_name(pkt.src)}: "
                  f"{pkt.data.hex()}")
            continue
        changed = t.diff(pkt.data)
        t.feed(pkt.data)
        for idx, old, new in changed:
            old_s = f"{old:02x}" if old is not None else "--"
            print(f"CFI {pkt.cfi} idx {idx:>2} [{_label(pkt.cfi, idx)}]: "
                  f"{old_s} -> {new:02x}")


def _parse_cfis(spec: str | None) -> set[int] | None:
    if not spec:
        return None
    return {int(x, 0) for x in spec.split(",")}


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description="A5 payload field explorer")
    p.add_argument("mode", choices=["survey", "watch"])
    p.add_argument("--port", default="socket://192.168.4.70:4000")
    p.add_argument("--cfi", help="comma-separated CFIs to watch (default: all)")
    p.add_argument("--seconds", type=float, default=30.0, help="survey window")
    p.add_argument("--poll", action="store_true",
                   help="actively send Get-Heat/Get-Schedule (sparse buses)")
    args = p.parse_args(argv)

    cfis = _parse_cfis(args.cfi)
    with EasyTouch(port=args.port) as et:
        if args.mode == "survey":
            print(survey(et, args.seconds, cfis, args.poll))
        else:
            try:
                watch(et, cfis)
            except KeyboardInterrupt:
                print("\nstopped")


if __name__ == "__main__":
    main()
