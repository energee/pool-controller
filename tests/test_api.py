"""Tests for the stdlib HTTP JSON API.

A loopback server is started on an ephemeral port (0) backed by an in-memory
``FakeMonitor`` that mimics BusMonitor's public surface — get_state / set_circuit
/ set_heat / set_schedule / wait_for — and updates its own state synchronously so
the confirm path resolves immediately.
"""
from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request

import pytest

from easytouch.api import make_server


class FakeMonitor:
    def __init__(self) -> None:
        self._status = {"clock": "11:01", "circuits_on": [6], "circuit_names": ["pool"],
                        "pool_temp": 83, "spa_temp": 83, "air_temp": 82, "unit": "F"}
        self._heat = {"pool_temp": 84, "spa_temp": 84, "air_temp": 85,
                      "pool_setpoint": 84, "spa_setpoint": 70,
                      "pool_heat_mode": "Heater", "spa_heat_mode": "Heater", "heat_mode_raw": 5}
        self.calls: list = []

    def get_state(self) -> dict:
        return {"connected": True, "error": None, "last_packet_ts": 1.0, "age": 0.0,
                "status": dict(self._status), "heat": dict(self._heat), "datetime": None,
                "pumps": {}, "schedules": {},
                "chlorinator": {"salt_ppm": 2750, "output_percent": 30, "status_flags": 128},
                "version": {"version": "2.080", "major": 2, "minor": 80, "raw": "0250"},
                "valves": {"valves": [0, 1, 2], "raw": "000102"},
                "intellichem": {"ph": 7.52, "orp": 700, "ph_setpoint": 7.6, "orp_setpoint": 720},
                "raw": {2: "00ffa5"}}

    def set_circuit(self, n: int, on: bool) -> None:
        self.calls.append(("circuit", n, on))
        if on and n not in self._status["circuits_on"]:
            self._status["circuits_on"].append(n)
        if not on and n in self._status["circuits_on"]:
            self._status["circuits_on"].remove(n)

    def set_heat(self, pool_setpoint=None, spa_setpoint=None, pool_mode=None, spa_mode=None) -> dict:
        self.calls.append(("heat", pool_setpoint, spa_setpoint, pool_mode, spa_mode))
        if pool_setpoint is not None:
            self._heat["pool_setpoint"] = pool_setpoint
        if spa_setpoint is not None:
            self._heat["spa_setpoint"] = spa_setpoint
        return {"pool_setpoint": self._heat["pool_setpoint"],
                "spa_setpoint": self._heat["spa_setpoint"],
                "heat_mode": self._heat["heat_mode_raw"]}

    def set_schedule(self, sid, circuit, start, end, days) -> None:
        self.calls.append(("schedule", sid, circuit, start, end, days))

    def set_chlorinator_output(self, percent) -> int:
        self.calls.append(("chlor", percent))
        return max(0, min(100, int(percent)))

    def set_datetime(self, when=None, auto_dst=True) -> dict:
        self.calls.append(("datetime", when))
        return {"hour": 11, "minute": 30, "year": 2026}

    def set_light(self, command) -> int:
        from easytouch import constants as C
        self.calls.append(("light", command))
        return C.resolve_light_command(command)

    def wait_for(self, predicate, timeout=6.0, interval=0.02):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            st = self.get_state()
            if predicate(st):
                return st
            time.sleep(interval)
        st = self.get_state()
        return st if predicate(st) else None


@pytest.fixture
def server():
    mon = FakeMonitor()
    srv = make_server("127.0.0.1", 0, mon, confirm_timeout=0.3)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        yield mon, srv.server_address[1]
    finally:
        srv.shutdown()
        srv.server_close()


def _get(port, path):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=5) as r:
        return r.status, json.loads(r.read())


def _get_raw(port, path):
    """GET returning (status, content-type, decoded text) — for non-JSON routes."""
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=5) as r:
        return r.status, r.headers.get("Content-Type", ""), r.read().decode()


def _post(port, path, obj):
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=json.dumps(obj).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=5) as r:
        return r.status, json.loads(r.read())


def test_get_state_returns_json_200(server):
    _mon, port = server
    code, body = _get(port, "/state")
    assert code == 200
    assert body["status"]["clock"] == "11:01"
    assert body["heat"]["pool_setpoint"] == 84


def test_root_serves_dashboard_html(server):
    _mon, port = server
    code, ctype, body = _get_raw(port, "/")
    assert code == 200
    assert ctype.startswith("text/html")
    assert "<title>easytouch" in body


def test_api_index_lists_endpoints(server):
    _mon, port = server
    code, body = _get(port, "/api")
    assert code == 200
    assert "endpoints" in body


def test_status_subset(server):
    _mon, port = server
    code, body = _get(port, "/status")
    assert code == 200
    assert body["circuits_on"] == [6]


def test_get_circuit_off_confirms(server):
    mon, port = server
    code, body = _get(port, "/circuit/pool/off")
    assert code == 200
    assert body["confirmed"] is True
    assert ("circuit", 6, False) in mon.calls
    assert 6 not in body["status"]["circuits_on"]


def test_get_heat_pool_setpoint(server):
    mon, port = server
    code, body = _get(port, "/heat/pool/85")
    assert code == 200
    assert body["heat"]["pool_setpoint"] == 85
    assert ("heat", 85, None, None, None) in mon.calls


def test_post_circuit_by_name(server):
    mon, port = server
    code, body = _post(port, "/circuit", {"circuit": "spa", "on": True})
    assert code == 200
    assert ("circuit", 1, True) in mon.calls


def test_post_heat(server):
    mon, port = server
    code, body = _post(port, "/heat", {"pool_setpoint": 86})
    assert code == 200
    assert body["heat"]["pool_setpoint"] == 86


def test_chlorinator_subset(server):
    _mon, port = server
    code, body = _get(port, "/chlorinator")
    assert code == 200
    assert body["salt_ppm"] == 2750
    assert body["output_percent"] == 30


def test_unknown_path_is_404(server):
    _mon, port = server
    with pytest.raises(urllib.error.HTTPError) as exc:
        _get(port, "/nope")
    assert exc.value.code == 404


def test_get_chlorinator_output_sets(server):
    mon, port = server
    code, body = _get(port, "/chlorinator/output/45")
    assert code == 200
    assert body["sent"] is True and body["output_percent"] == 45
    assert ("chlor", 45) in mon.calls


def test_post_chlorinator_output(server):
    mon, port = server
    code, body = _post(port, "/chlorinator", {"output": 60})
    assert code == 200
    assert body["output_percent"] == 60
    assert ("chlor", 60) in mon.calls


def test_post_datetime(server):
    mon, port = server
    code, body = _post(port, "/datetime", {})
    assert code == 200
    assert body["sent"] is True
    assert any(c[0] == "datetime" for c in mon.calls)


def test_get_version_subset(server):
    _mon, port = server
    code, body = _get(port, "/version")
    assert code == 200
    assert body["version"] == "2.080"


def test_get_valves_subset(server):
    _mon, port = server
    code, body = _get(port, "/valves")
    assert code == 200
    assert body["valves"] == [0, 1, 2]


def test_get_intellichem_subset(server):
    _mon, port = server
    code, body = _get(port, "/intellichem")
    assert code == 200
    assert body["orp"] == 700


def test_get_light_command(server):
    mon, port = server
    code, body = _get(port, "/light/party")
    assert code == 200
    assert body["sent"] is True and body["code"] == 177
    assert ("light", "party") in mon.calls


def test_post_light_unknown_is_400(server):
    _mon, port = server
    with pytest.raises(urllib.error.HTTPError) as exc:
        _post(port, "/light", {"command": "disco"})
    assert exc.value.code == 400
