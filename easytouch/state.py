"""
easytouch.state — a single background owner of the RS-485 connection.

The bus is half-duplex with exactly **one** usable connection, so the HTTP API
must not open the serial port per request. :class:`BusMonitor` runs one daemon
thread that owns an :class:`~easytouch.controller.EasyTouch`, continuously reads
and decodes traffic into a cached, JSON-able snapshot, periodically *requests*
the sparse packet types (heat, schedules), and drains a command queue so writes
from any HTTP thread are serialized onto the single bus owner::

    HTTP handlers ──read──> cached state  ◄──updates── BusMonitor thread ──> bus
                  └──enqueue command──> queue ──drained by──┘

Tests drive the monitor synchronously via :meth:`_poll_once` (one read → ingest →
refresh → drain cycle) with a stub serial; production uses :meth:`start`.
"""
from __future__ import annotations

import queue
import threading
import time
from dataclasses import asdict
from typing import Callable

from . import constants as C
from .controller import DEFAULT_BAUD, EasyTouch
from .decode import (
    CircuitNames,
    ControllerStatus,
    DateTime,
    HeatStatus,
    IntelliChem,
    PumpStatus,
    Schedule,
    SoftwareVersion,
    ValveStatus,
    decode,
    encode_days,
    merge_heat_mode,
)
from .intellichlor import (
    ChlorinatorReader,
    ChlorinatorSetOutput,
    ChlorinatorStatus,
    build_set_output,
    decode_ic,
)

# EasyTouch stores 12 schedule slots (ids 1..12). The controller answers a
# Get-Schedule only for the slot id in the request — slot 0 is always empty — so
# every slot must be polled individually to discover the programmed schedules.
SCHEDULE_SLOTS = 12


def _to_jsonable(obj) -> dict:
    """Convert a decoded dataclass to a JSON-able dict plus computed conveniences."""
    d = asdict(obj)
    if isinstance(obj, ControllerStatus):
        d["unit"] = obj.unit
    elif isinstance(obj, DateTime):
        d["iso"] = obj.iso
    elif isinstance(obj, Schedule):
        d["active"] = obj.active
    return d


class BusMonitor:
    """Owns the serial connection on a background thread and caches decoded state.

    State keys: ``status`` (CFI 2), ``heat`` (CFI 8), ``datetime`` (CFI 5),
    ``pumps`` (by pump number), ``schedules`` (by id). Every decoded frame's raw
    hex is also kept under ``raw[cfi]`` so undecoded packet types remain visible.
    """

    def __init__(
        self,
        port: str,
        baud: int = DEFAULT_BAUD,
        address: int = C.Address.REMOTE,
        refresh_interval: float = 15.0,
    ) -> None:
        self._et = EasyTouch(port=port, baud=baud, address=address)
        self.refresh_interval = refresh_interval
        self._lock = threading.Lock()
        self.state: dict = {"pumps": {}, "schedules": {}}
        self.raw: dict[int, str] = {}
        # The salt chlorinator speaks its own (non-A5) protocol on the same wire;
        # a second framer over the raw byte stream decodes it into this dict.
        self._chlor_reader = ChlorinatorReader()
        self._chlor: dict = {}
        self._chlor_ts: float | None = None   # wall-clock of the last IC frame
        self._cmd_q: "queue.Queue" = queue.Queue()
        self.connected = False
        self.last_packet_ts: float | None = None
        self.error: str | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._next_refresh = 0.0          # monotonic deadline; 0 = refresh as soon as primed
        self._primed = False              # True once a controller packet teaches us its sub
        # After a write, re-request the relevant status for this many polls so the
        # cache (and the HTTP confirm) reflects the change within the confirm window
        # even if the controller's first reply races ahead of applying the write.
        self._heat_reread = 0
        self._sched_reread = 0
        self._sched_reread_id = 1         # which slot the pending re-reads target
        # Schedule slots are polled one id at a time, paced — the controller drops
        # a burst of back-to-back Get-Schedule requests on the half-duplex bus.
        self._sched_scan: list[int] = []
        self._next_sched_req = 0.0        # monotonic gate for the next scan request
        self._sched_req_gap = 1.0         # seconds between scan requests (0 in tests)

    # --- lifecycle ---------------------------------------------------------
    def start(self) -> "BusMonitor":
        if self._thread and self._thread.is_alive():
            return self
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="easytouch-bus", daemon=True)
        self._thread.start()
        return self

    def stop(self, timeout: float = 2.0) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=timeout)

    def _run(self) -> None:
        try:
            self._et.open()
            self.connected = True
        except Exception as exc:                      # noqa: BLE001 - report, then retry
            self.error = str(exc)
            self.connected = False
        while not self._stop.is_set():
            ok = False
            try:
                ok = self._poll_once()
            except Exception as exc:                  # noqa: BLE001 - never kill the thread
                self.error = str(exc)
                self.connected = False
            if not ok:
                self._stop.wait(1.0)                  # backoff, then try to reconnect
                try:
                    self._et.close()
                    self._et.open()
                    self.connected = True
                    self.error = None
                except Exception as exc:              # noqa: BLE001
                    self.error = str(exc)
                    self.connected = False
        self._et.close()

    # --- one read/ingest/refresh/drain cycle (also the unit-test seam) -----
    def _poll_once(self, read_size: int = 256) -> bool:
        try:
            chunk = self._et.serial.read(read_size)
        except Exception as exc:                      # noqa: BLE001
            self.connected = False
            self.error = str(exc)
            return False
        self.connected = True
        self.error = None
        for pkt in self._et._feed(chunk):
            self._ingest(pkt)
        for frame in self._chlor_reader.feed(chunk):
            self._ingest_ic(frame)
        self._maybe_refresh()
        self._service_sched_scan()
        self._service_rereads()
        self._drain_commands()
        return True

    def _service_rereads(self) -> None:
        """Re-request status types whose write is still being confirmed."""
        if not self._primed:
            return
        if self._heat_reread > 0:
            self._heat_reread -= 1
            self._cmd_q.put(self._et.build_get_heat())
        if self._sched_reread > 0:
            self._sched_reread -= 1
            self._cmd_q.put(self._et.build_get_schedules(self._sched_reread_id))

    def _service_sched_scan(self) -> None:
        """Send one queued schedule-slot request per call, paced by a short gap.

        The controller drops a burst of back-to-back Get-Schedule requests on the
        half-duplex bus (and answers only for the slot id asked), so the scan
        queued by :meth:`_maybe_refresh` is drained one id at a time — the same
        cadence a one-shot :meth:`EasyTouch.get_schedules` uses.
        """
        if not self._primed or not self._sched_scan:
            return
        now = time.monotonic()
        if now < self._next_sched_req:
            return
        self._next_sched_req = now + self._sched_req_gap
        sid = self._sched_scan.pop(0)
        self._cmd_q.put(self._et.build_get_schedules(sid))

    def _ingest(self, pkt) -> None:
        obj = decode(pkt)
        with self._lock:
            if isinstance(obj, ControllerStatus):
                self.state["status"] = obj
            elif isinstance(obj, HeatStatus):
                self.state["heat"] = obj
            elif isinstance(obj, DateTime):
                self.state["datetime"] = obj
            elif isinstance(obj, PumpStatus):
                self.state.setdefault("pumps", {})[obj.pump] = obj
            elif isinstance(obj, Schedule):
                self.state.setdefault("schedules", {})[obj.id] = obj
            elif isinstance(obj, SoftwareVersion):
                self.state["version"] = obj
            elif isinstance(obj, ValveStatus):
                self.state["valves"] = obj
            elif isinstance(obj, IntelliChem):
                self.state["intellichem"] = obj
            elif isinstance(obj, CircuitNames):
                self.state.setdefault("names", {})[obj.circuit] = obj
            self.raw[pkt.cfi] = pkt.to_bytes(idle=0).hex()
            self.last_packet_ts = time.time()
            if pkt.src == C.Address.MAIN:
                # EasyTouch._feed has now learned the controller's real sub from
                # this frame, so requests we send will be honored.
                self._primed = True

    def _ingest_ic(self, frame) -> None:
        """Merge a decoded IntelliChlor frame into the cached chlorinator state.

        Salt and status arrive in the chlorinator's status frame (cmd 0x12); the
        requested output % rides a separate set-output frame (cmd 0x11), so the
        two are merged field-by-field rather than replaced wholesale.
        """
        obj = decode_ic(frame)
        if obj is None:
            return
        with self._lock:
            if isinstance(obj, ChlorinatorStatus):
                self._chlor["salt_ppm"] = obj.salt_ppm
                self._chlor["status_flags"] = obj.status_flags
            elif isinstance(obj, ChlorinatorSetOutput):
                self._chlor["output_percent"] = obj.output_percent
            now = time.time()
            self._chlor_ts = now              # for the "last seen" / staleness display
            self.last_packet_ts = now

    def _maybe_refresh(self) -> None:
        """Periodically request the sparse packet types (heat, schedules).

        Held off until a controller packet has taught us the real sub-version —
        the controller ignores requests stamped with the default sub, so an early
        refresh would just be wasted.
        """
        if not self._primed:
            return
        now = time.monotonic()
        if now >= self._next_refresh:
            self._next_refresh = now + self.refresh_interval
            self._cmd_q.put(self._et.build_get_heat())
            if "version" not in self.state:        # firmware is static; ask until seen
                self._cmd_q.put(self._et.build_get_version())
            # Queue a full schedule re-scan. The controller answers only for the id
            # in the request (a single id-0 request never surfaces slots 1..N) and
            # drops a burst of requests, so slots are polled one at a time, paced,
            # by _service_sched_scan. Delay the first slot by one gap so it is not
            # bundled into this same drain as Get-Heat (that burst loses slot 1).
            self._sched_scan = list(range(1, SCHEDULE_SLOTS + 1))
            self._next_sched_req = now + self._sched_req_gap

    def _drain_commands(self) -> None:
        while True:
            try:
                pkt = self._cmd_q.get_nowait()
            except queue.Empty:
                return
            try:
                # Most commands are A5 Packets; IntelliChlor frames are pre-built
                # raw bytes (its native protocol) and go out verbatim.
                if isinstance(pkt, (bytes, bytearray)):
                    self._et.send_raw(bytes(pkt))
                else:
                    self._et.send(pkt)
            except Exception as exc:                  # noqa: BLE001
                self.error = str(exc)

    # --- reads -------------------------------------------------------------
    def get_state(self) -> dict:
        """Return a JSON-able snapshot of decoded state, raw frames, and metadata."""
        with self._lock:
            status = self.state.get("status")
            heat = self.state.get("heat")
            dt = self.state.get("datetime")
            ver = self.state.get("version")
            valves = self.state.get("valves")
            chem = self.state.get("intellichem")
            names = dict(self.state.get("names", {}))
            pumps = dict(self.state.get("pumps", {}))
            scheds = dict(self.state.get("schedules", {}))
            raw = dict(self.raw)
            chlor = dict(self._chlor)
            chlor_ts = self._chlor_ts
            last = self.last_packet_ts
            connected = self.connected
            error = self.error
        now = time.time()
        # Stamp the chlorinator with how long ago it last spoke, so the UI can show
        # staleness instead of silently vanishing when the cell goes quiet (it only
        # reports while the pool is running).
        if chlor:
            chlor["last_seen_ts"] = chlor_ts
            chlor["age"] = (now - chlor_ts) if chlor_ts is not None else None
        return {
            "connected": connected,
            "error": error,
            "last_packet_ts": last,
            "age": (now - last) if last is not None else None,
            "status": _to_jsonable(status) if status else None,
            "heat": _to_jsonable(heat) if heat else None,
            "datetime": _to_jsonable(dt) if dt else None,
            "version": _to_jsonable(ver) if ver else None,
            "valves": _to_jsonable(valves) if valves else None,
            "intellichem": _to_jsonable(chem) if chem else None,
            "names": {n: _to_jsonable(o) for n, o in names.items()},
            "pumps": {n: _to_jsonable(p) for n, p in pumps.items()},
            "schedules": {i: _to_jsonable(s) for i, s in scheds.items()},
            "chlorinator": chlor or None,
            "raw": raw,
        }

    def wait_for(
        self,
        predicate: Callable[[dict], bool],
        timeout: float = 6.0,
        interval: float = 0.1,
    ) -> dict | None:
        """Poll :meth:`get_state` until ``predicate`` holds; return it, else ``None``."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            st = self.get_state()
            if predicate(st):
                return st
            time.sleep(interval)
        st = self.get_state()
        return st if predicate(st) else None

    # --- commands (enqueued; the single bus owner sends them) --------------
    def set_circuit(self, circuit: int, on: bool) -> None:
        self._cmd_q.put(self._et.build_set_circuit(circuit, bool(on)))

    def set_chlorinator_output(self, percent: int) -> int:
        """Enqueue an IntelliChlor Set-Output (raw native frame); return the clamped %.

        The cell's status frame (cmd 0x12) carries salt but not output, so the
        requested value is cached optimistically here for the UI; the next observed
        controller set-output frame (cmd 0x11) corrects it. Best-effort — a present
        EasyTouch controller may override a direct injection (see HANDOFF).
        """
        pct = max(0, min(100, int(percent)))
        self._cmd_q.put(build_set_output(pct))
        with self._lock:
            self._chlor["output_percent"] = pct
        return pct

    def set_datetime(self, when=None, auto_dst: bool = True) -> dict:
        """Enqueue a Set-Date/Time (defaults to the host's current local time)."""
        from .controller import datetime_fields
        h, m, dow, day, mon, yr, dst = datetime_fields(when, auto_dst)
        self._cmd_q.put(self._et.build_set_datetime(h, m, dow, day, mon, yr, dst))
        return {"hour": h, "minute": m, "dow": dow, "day": day, "month": mon,
                "year": 2000 + yr, "auto_dst": bool(dst)}

    def set_light(self, command) -> int:
        """Enqueue an IntelliBrite light command; returns the resolved code."""
        code = C.resolve_light_command(command)
        self._cmd_q.put(self._et.build_set_light(code))
        return code

    def set_pump_speed(self, pump: int, rpm: int) -> dict:
        """EXPERIMENTAL pump RPM command (see :meth:`EasyTouch.set_pump_speed`).

        Enqueues remote-control + set-speed frames. Unverified and may contend with
        the controller's pump programs.
        """
        self._cmd_q.put(self._et.build_pump_remote_control(pump, True))
        self._cmd_q.put(self._et.build_set_pump_speed(pump, rpm))
        return {"pump": pump, "rpm": rpm, "experimental": True}

    def set_heat(
        self,
        pool_setpoint: int | None = None,
        spa_setpoint: int | None = None,
        pool_mode: int | None = None,
        spa_mode: int | None = None,
    ) -> dict:
        """Enqueue a Set-Heat built from the cached heat status (read-modify-write).

        Raises :class:`RuntimeError` if no heat status has been cached yet (the
        monitor cannot read it synchronously from another thread).
        """
        with self._lock:
            cur = self.state.get("heat")
        if cur is None:
            raise RuntimeError("no heat status cached yet; try again shortly")
        psp = cur.pool_setpoint if pool_setpoint is None else pool_setpoint
        ssp = cur.spa_setpoint if spa_setpoint is None else spa_setpoint
        mode = merge_heat_mode(cur.heat_mode_raw, pool_mode, spa_mode)
        self._cmd_q.put(self._et.build_set_heat(psp, ssp, mode))
        # Heat status isn't broadcast unsolicited, so re-request it across the next
        # several polls — one immediate read can race the controller's apply.
        self._heat_reread = 20
        return {"pool_setpoint": psp, "spa_setpoint": ssp, "heat_mode": mode}

    def set_schedule(self, schedule_id: int, circuit: int, start: str, end: str, days) -> None:
        mask = days if isinstance(days, int) else encode_days(days)
        self._cmd_q.put(self._et.build_set_schedule(schedule_id, circuit, start, end, mask))
        self._sched_reread = 12          # re-read across the confirm window
        self._sched_reread_id = schedule_id   # ...the slot we just wrote
