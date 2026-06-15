"""
easytouch.api — a stdlib HTTP JSON API over the EasyTouch bus (no dependencies).

A :class:`~easytouch.state.BusMonitor` owns the single serial connection on a
background thread; the HTTP handlers only read its cached state and enqueue
commands, so concurrent requests never contend for the half-duplex bus. Control
endpoints enqueue a command, then poll the cache (``wait_for``) for confirmation:
they return ``200`` with the new state when confirmed, or ``202 accepted`` when
the controller hasn't echoed the change within ``confirm_timeout``.

Routes (LAN, no auth):

==========  ===========================  ===================================
Method      Path                         Action
==========  ===========================  ===================================
GET         ``/``                        the human dashboard (HTML)
GET         ``/api``                     endpoint index (JSON)
GET         ``/state``                   full cached snapshot
GET         ``/status`` ``/heat``        decoded subsets
            ``/datetime`` ``/pumps``
            ``/schedules`` ``/chlorinator``
            ``/raw``
GET         ``/circuit/<name|num>/<on|off>``   set a circuit (convenience)
GET         ``/heat/pool/<temp>``        set pool setpoint (convenience)
GET         ``/heat/spa/<temp>``         set spa setpoint (convenience)
POST        ``/circuit``                 ``{circuit, on}``
POST        ``/heat``                    ``{pool_setpoint, spa_setpoint, pool_mode, spa_mode}``
POST        ``/schedule``                ``{id, circuit, start, end, days}``
==========  ===========================  ===================================
"""
from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from . import constants as C
from .controller import DEFAULT_BAUD, resolve_circuit
from .state import BusMonitor
from .web import PAGE

CONFIRM_TIMEOUT = 6.0

# Subsets of get_state() exposed as their own GET endpoints.
_SUBSETS = ("status", "heat", "datetime", "pumps", "schedules", "chlorinator", "raw")

ENDPOINTS = {
    "GET /": "the dashboard (HTML)",
    "GET /api": "this endpoint index (JSON)",
    "GET /state": "full cached snapshot",
    "GET /{status,heat,datetime,pumps,schedules,chlorinator,raw}": "decoded subsets",
    "GET /circuit/<name-or-num>/<on|off>": "set a circuit",
    "GET /heat/pool/<temp>": "set pool setpoint",
    "GET /heat/spa/<temp>": "set spa setpoint",
    "GET /chlorinator/output/<pct>": "set chlorinator output %",
    "POST /circuit": "{circuit, on}",
    "POST /heat": "{pool_setpoint, spa_setpoint, pool_mode, spa_mode}",
    "POST /schedule": "{id, circuit, start, end, days}",
    "POST /chlorinator": "{output}",
}


class PoolServer(ThreadingHTTPServer):
    """Threading HTTP server that carries a shared :class:`BusMonitor`."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, monitor, confirm_timeout: float = CONFIRM_TIMEOUT) -> None:
        super().__init__(addr, PoolHandler)
        self.monitor = monitor
        self.confirm_timeout = confirm_timeout


def make_server(http_host: str, http_port: int, monitor, confirm_timeout: float = CONFIRM_TIMEOUT) -> PoolServer:
    """Build (but do not start) a :class:`PoolServer` bound to ``http_host:http_port``."""
    return PoolServer((http_host, http_port), monitor, confirm_timeout)


class PoolHandler(BaseHTTPRequestHandler):
    server_version = "easytouch/0.1"

    # --- plumbing ----------------------------------------------------------
    def log_message(self, *args) -> None:  # silence default stderr access log
        pass

    @property
    def monitor(self) -> BusMonitor:
        return self.server.monitor

    @property
    def confirm_timeout(self) -> float:
        return self.server.confirm_timeout

    def _send(self, code: int, obj) -> None:
        body = (json.dumps(obj, indent=2, default=str) + "\n").encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, code: int, html: str) -> None:
        body = html.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _err(self, code: int, message: str) -> None:
        self._send(code, {"error": message})

    def _read_json(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        raw = self.rfile.read(n)
        try:
            return json.loads(raw or b"{}")
        except ValueError as exc:
            raise ValueError(f"invalid JSON body: {exc}") from exc

    def _dispatch(self, fn) -> None:
        try:
            fn()
        except ValueError as exc:        # bad input (path/body/circuit name)
            self._err(400, str(exc))
        except RuntimeError as exc:       # e.g. set_heat before heat is cached
            self._err(503, str(exc))
        except Exception as exc:          # noqa: BLE001 - last-resort 500
            self._err(500, str(exc))

    def _parts(self):
        return [p for p in urlparse(self.path).path.split("/") if p]

    # --- GET ---------------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        self._dispatch(lambda: self._route_get(self._parts()))

    def _route_get(self, parts) -> None:
        m = self.monitor
        if not parts:
            return self._send_html(200, PAGE)        # the human dashboard
        head = parts[0]
        if head == "api" and len(parts) == 1:
            return self._send(200, {"endpoints": ENDPOINTS})
        if head == "state" and len(parts) == 1:
            return self._send(200, m.get_state())
        if head in _SUBSETS and len(parts) == 1:
            return self._send(200, m.get_state().get(head))
        if head == "circuit" and len(parts) == 3:
            return self._circuit(parts[1], parts[2])
        if head == "heat" and len(parts) == 3 and parts[1] in ("pool", "spa"):
            return self._heat_setpoint(parts[1], parts[2])
        if head == "chlorinator" and len(parts) == 3 and parts[1] == "output":
            return self._chlor_output(parts[2])
        return self._err(404, f"no such path: /{'/'.join(parts)}")

    # --- POST --------------------------------------------------------------
    def do_POST(self) -> None:  # noqa: N802 - stdlib naming
        self._dispatch(lambda: self._route_post(self._parts(), self._read_json()))

    def _route_post(self, parts, body) -> None:
        if parts == ["circuit"]:
            if "circuit" not in body:
                raise ValueError("body must include 'circuit'")
            return self._circuit(str(body["circuit"]), "on" if body.get("on") else "off")
        if parts == ["heat"]:
            kwargs = {k: body[k] for k in ("pool_setpoint", "spa_setpoint", "pool_mode", "spa_mode")
                      if body.get(k) is not None}
            if not kwargs:
                raise ValueError("body must include at least one heat field")
            return self._set_heat(kwargs)
        if parts == ["schedule"]:
            for key in ("id", "circuit", "start", "end"):
                if key not in body:
                    raise ValueError(f"body must include '{key}'")
            return self._set_schedule(body)
        if parts == ["chlorinator"]:
            value = body.get("output", body.get("percent"))
            if value is None:
                raise ValueError("body must include 'output' (0-100)")
            return self._set_chlor(value)
        return self._err(404, f"no such path: /{'/'.join(parts)}")

    # --- control helpers ---------------------------------------------------
    def _circuit(self, name_or_num: str, action: str) -> None:
        circuit = resolve_circuit(name_or_num)
        flag = {"on": True, "1": True, "off": False, "0": False}.get(action.lower())
        if flag is None:
            raise ValueError("circuit action must be on/off")
        self.monitor.set_circuit(circuit, flag)
        st = self.monitor.wait_for(
            lambda s: s.get("status") and (circuit in s["status"]["circuits_on"]) == flag,
            timeout=self.confirm_timeout)
        if st is None:
            return self._send(202, {"accepted": True, "circuit": circuit, "on": flag})
        return self._send(200, {"confirmed": True, "circuit": circuit, "on": flag,
                                "status": st["status"]})

    def _heat_setpoint(self, which: str, temp: str) -> None:
        try:
            value = int(temp)
        except ValueError as exc:
            raise ValueError(f"temperature must be an integer, got {temp!r}") from exc
        self._set_heat({f"{which}_setpoint": value})

    def _set_heat(self, kwargs: dict) -> None:
        res = self.monitor.set_heat(**kwargs)

        def matches(s) -> bool:
            h = s.get("heat")
            return bool(h) and h["pool_setpoint"] == res["pool_setpoint"] \
                and h["spa_setpoint"] == res["spa_setpoint"] \
                and h["heat_mode_raw"] == res["heat_mode"]

        st = self.monitor.wait_for(matches, timeout=self.confirm_timeout)
        if st is None:
            return self._send(202, {"accepted": True, "requested": res})
        return self._send(200, {"confirmed": True, "heat": st["heat"]})

    def _set_schedule(self, body: dict) -> None:
        sid = int(body["id"])
        circuit = resolve_circuit(str(body["circuit"]))
        self.monitor.set_schedule(sid, circuit, body["start"], body["end"],
                                  body.get("days", "every"))
        st = self.monitor.wait_for(lambda s: sid in s.get("schedules", {}),
                                   timeout=self.confirm_timeout)
        if st is None:
            return self._send(202, {"accepted": True, "id": sid})
        return self._send(200, {"confirmed": True, "schedule": st["schedules"][sid]})

    def _chlor_output(self, pct: str) -> None:
        try:
            value = int(pct)
        except ValueError as exc:
            raise ValueError(f"output must be an integer 0-100, got {pct!r}") from exc
        self._set_chlor(value)

    def _set_chlor(self, value) -> None:
        # The cell's status frame carries salt but not output, so there is nothing
        # to confirm against — report what was sent (best-effort; see HANDOFF).
        pct = self.monitor.set_chlorinator_output(int(value))
        self._send(200, {"sent": True, "output_percent": pct})


def serve(
    port: str,
    baud: int = DEFAULT_BAUD,
    address: int = C.Address.REMOTE,
    http_host: str = "0.0.0.0",
    http_port: int = 8080,
    refresh_interval: float = 15.0,
) -> None:
    """Start the BusMonitor and serve the HTTP API until interrupted.

    ``port`` is the serial/network bus (e.g. ``socket://192.168.4.70:4000``);
    ``http_host``/``http_port`` bind the HTTP listener.
    """
    monitor = BusMonitor(port, baud=baud, address=address, refresh_interval=refresh_interval)
    monitor.start()
    srv = make_server(http_host, http_port, monitor)
    print(f"easytouch API on http://{http_host}:{http_port}  (bus: {port})", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.shutdown()
        srv.server_close()
        monitor.stop()
