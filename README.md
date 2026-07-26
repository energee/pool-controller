# easytouch

A lightweight Python toolkit to **monitor and control a Pentair EasyTouch /
IntelliTouch pool controller over its RS-485 bus.**

It speaks the reverse-engineered Pentair "A5" protocol (documented in
[`michaelusner/pentair-pool-controler`](https://github.com/michaelusner/pentair-pool-controler)),
talks to the bus through any serial device — including a `/tmp/vserial` PTY
bridged over TCP — decodes controller / pump / date-time packets, and lets you
flip circuits on and off.

```
┌────────────┐   RS-485    ┌───────────┐   socat/TCP   ┌──────────────┐
│ EasyTouch  │◄──────────► │  adapter  │◄────────────► │ /tmp/vserial │◄── easytouch
│ controller │   9600 8N1  │ or bridge │               │   (PTY)      │
└────────────┘             └───────────┘               └──────────────┘
```

## Why it's "lightweight"

* One runtime dependency (`pyserial`).
* A clean layered design — pure protocol code with no I/O, a streaming framer, a
  decoder, then a thin serial client and CLI on top — so the parser is fully
  unit-testable without hardware.
* No daemon, no broker, no config files required.

## Install

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -e .
```

## The bus / `/tmp/vserial`

This project was developed against a virtual serial port created by `socat`,
which bridges the bus (exposed as a TCP stream) to a local PTY:

```bash
socat -d -d PTY,link=/tmp/vserial,raw,echo=0 TCP:<bus-host>:4000
```

Anything that presents the bus as a serial port works the same way: a real
USB RS-485 adapter (`/dev/ttyUSB0`), the socat PTY above, etc. The bus runs at
**9600 baud, 8N1**.

### Reaching the bus over the network (no local PTY)

If the RS-485 adapter lives on another machine, export it as a raw TCP stream and
point `--port` at it directly — no local `socat`/PTY needed:

```bash
# on the adapter host
socat TCP-LISTEN:4000,reuseaddr /dev/cu.usbserial-XXXX,raw,echo=0,b9600

# from anywhere on the LAN
python -m easytouch --port socket://192.168.4.70:4000 status
```

`--port` accepts `socket://HOST:PORT` (raw TCP) or `tcp://HOST:PORT` (an alias).

### Development without hardware (mock bus)

`tools/mock_bus.py` is a fake controller that speaks the same wire protocol over
TCP — no USB adapter, no PTY, no `socat`:

```bash
python tools/mock_bus.py &                                    # 127.0.0.1:4000
python -m easytouch --port socket://127.0.0.1:4000 serve --http-port 8080
# then open http://localhost:8080/
```

It broadcasts controller status, date/time, pump and IntelliChlor frames, answers
the heat / schedule / version requests `BusMonitor` makes, and applies writes
(circuits, heat set-points, schedules, clock, chlorinator output) to its in-memory
state — so dashboard controls confirm exactly as they do against real hardware.
`--host`/`--port` move the listener; `--selftest` decodes every generated frame
through the real decoders and exits.

Frontend work is the same loop plus a rebuild: edit `frontend/`, run
`bun run build`, reload the page (the server ships the committed
`easytouch/static/` bundle, so nothing is served from `frontend/` directly).

## Run on a Raspberry Pi (systemd)

Deploy the dashboard on a Pi wired straight to the RS-485 bus. Only Python
≥3.9 and `pyserial` are needed at runtime — the frontend is served from the
committed `easytouch/static/` build, so **no Node/Bun on the Pi**.

```bash
# 1. Get the code and install (creates .venv with pyserial)
git clone git@github.com:energee/pool-controller.git ~/pool   # or: cd ~/pool && git pull
cd ~/pool
# Raspberry Pi OS ships an old pip; -U pip is needed for the editable install below.
python3 -m venv .venv && .venv/bin/pip install -U pip && .venv/bin/pip install -e .

# 2. Find the serial device. Common: /dev/serial0 (GPIO UART) or /dev/ttyUSB0 (USB adapter)
ls -l /dev/serial* /dev/ttyUSB* 2>/dev/null

# 3. Sanity-check against the live bus (Ctrl-C to stop)
.venv/bin/python -m easytouch --port /dev/serial0 status
```

If you use the Pi's **GPIO UART** (`/dev/serial0`), enable it and free it from
the login console first: `sudo raspi-config` → *Interface Options* → *Serial
Port* → login shell **No**, serial hardware **Yes**, then reboot. (USB RS-485
adapters need no such step.)

Install as a boot service (auto-starts, restarts on crash):

```bash
sudo cp deploy/easytouch.service /etc/systemd/system/
# Adjust User=, the two /home/pi/pool paths, and --port if they differ:
sudoedit /etc/systemd/system/easytouch.service
sudo systemctl daemon-reload
sudo systemctl enable --now easytouch
systemctl status easytouch     # should read: active (running)
journalctl -u easytouch -f     # live logs
```

Then open `http://<pi-ip>:8080/` from any device on the LAN.

## CLI

```bash
# Live, decoded traffic
python -m easytouch monitor

# One decoded snapshot of the whole system
python -m easytouch status

# Same, as JSON (for scripts / Home Assistant / MQTT bridges)
python -m easytouch json

# Toggle circuits by name or number
python -m easytouch on pool
python -m easytouch off spa
python -m easytouch on 6            # circuit 6 == pool by default

# View / configure schedules
python -m easytouch schedules
python -m easytouch set-schedule --id 1 --circuit pool --start 08:00 --end 10:30 --days mon,wed,fri
python -m easytouch set-schedule --id 2 --circuit spa  --start 18:00 --end 21:00 --days weekends

# Heat / temperature set-points and modes
python -m easytouch heat                         # current temps + setpoints
python -m easytouch set-heat --pool 85           # raise pool setpoint to 85
python -m easytouch set-heat --spa 102 --spa-mode heater
python -m easytouch set-heat --pool-mode off     # modes: off/heater/solar/solar-only (or 0-3)

# Salt-cell output %, controller clock, IntelliBrite lights, pump RPM
python -m easytouch set-chlor --percent 40       # set salt-cell generation output
python -m easytouch set-clock                     # sync the controller clock to now
python -m easytouch light party                   # IntelliBrite theme/color/on/off
python -m easytouch set-pump --pump 1 --rpm 2400  # EXPERIMENTAL (unverified)

# Serve the HTTP JSON API (owns the bus; see below)
python -m easytouch --port socket://192.168.4.70:4000 serve --http-port 8080

# Raw hex frames for debugging
python -m easytouch raw --seconds 5

# Point at a different port
python -m easytouch --port /dev/ttyUSB0 status
```

Example `status` output:

```
EasyTouch status @ /tmp/vserial:
  Clock        : 11:01
  Circuits on  : pool  [6]
  Pool temp    : 83°F
  Spa temp     : 83°F
  Air temp     : 82°F
  Solar temp   : 0°F
  Heater       : ON
  Heat mode    : pool=Heater  spa=Heater
```

## Library API

```python
from easytouch import EasyTouch

with EasyTouch("/tmp/vserial") as et:
    status = et.snapshot()                 # next decoded controller-status broadcast
    print(status.clock, status.pool_temp, status.circuit_names)

    et.set_circuit(6, on=True)             # turn the pool circuit on (confirmed)

    heat = et.get_heat()                   # temps + set-points (CFI 8)
    print(heat.pool_setpoint, heat.spa_setpoint, heat.pool_heat_mode)
    et.set_heat(pool_setpoint=85)          # read-modify-write; other fields preserved

    et.set_light("party")                  # IntelliBrite light command (CFI 96)
    et.set_datetime()                      # sync the controller clock to now (CFI 133)
    et.set_pump_speed(1, 2400)             # EXPERIMENTAL pump RPM (unverified)

    for pkt in et.packets():               # stream every decoded packet
        print(pkt)
```

Decoders return typed dataclasses (`ControllerStatus`, `DateTime`, `HeatStatus`,
`PumpStatus`, `Schedule`, plus `SoftwareVersion`, `ValveStatus`, `IntelliChem`,
`CircuitNames`) or an `Unknown` wrapper for frames without a dedicated decoder, so
monitoring never silently drops traffic.

Decoded fields per type (all surface in the HTTP API's JSON via `dataclasses.asdict`):

- **`ControllerStatus`** — `clock`, `circuits_on`/`circuit_names`, `pool_temp`,
  `spa_temp`, `air_temp`, `solar_temp`, `heater_on`, `pool_heat_mode`,
  `spa_heat_mode`, `celsius`, `service`, `freeze`, plus `valve` (valve-actuator
  state), `delay` (0 = none, else the circuit currently in its valve delay), and
  `auto_dst` (panel auto-adjusts daylight saving time).
- **`HeatStatus`** — `pool_temp`, `spa_temp`, `air_temp`, `pool_setpoint`,
  `spa_setpoint`, `pool_heat_mode`/`spa_heat_mode`, `heat_mode_raw`, plus
  `cool_setpoint` (chill set-point for heat-pump/UltraTemp; reads `100` when no
  cooling-capable heater is configured).
- **`PumpStatus`** — `pump`, `cmd`, `mode`, `drive_state`, `watts`, `rpm`, `gpm`,
  `ppc`, `error`, `run_minutes`. **Note:** the previously mislabeled fields were
  corrected — what was `run_state` is now `mode`, and the old `mode` is now
  `drive_state`. Consumers of the `/state` → `pumps` JSON must update those keys.
- **`SoftwareVersion`** (CFI 252), **`ValveStatus`** (CFI 29), **`IntelliChem`**
  (CFI 18 — pH/ORP + setpoints), **`CircuitNames`** (CFI 11 — circuit function +
  name id): previously raw-hex only, now decoded *and* surfaced (`/version`,
  `/valves`, `/intellichem`, `/names`). Their field layouts follow the documented
  reference mapping and are **not yet confirmed against this hardware** (no live
  capture), so each carries an authoritative `raw` payload and says so in its
  docstring. `CircuitNames` exposes the name *id*, not resolved text (which needs
  the Pentair name table + a capture), so `DEFAULT_CIRCUITS` stays the display name
  source.

`set_heat()` carries all four heat values (pool/spa set-points and modes) in one
frame, so it first reads the current `HeatStatus` and preserves any field you
leave at `None`.

## Schedules

View and configure the controller's stored schedule slots:

```python
with EasyTouch("/tmp/vserial") as et:
    for s in et.get_schedules():
        print(s.id, s.circuit_name, s.start, "-", s.end, s.days)

    et.set_schedule(id=1, circuit=6, start="08:00", end="10:30",
                    days=["mon", "wed", "fri"])   # days may also be a raw bitmask
```

* `get_schedules()` sends a *Get Schedule* (`CFI 209`) request and collects the
  `CFI 17` schedule packets the controller broadcasts in reply.
* `set_schedule(...)` sends a *Set Schedule* (`CFI 145`) write; with
  `confirm=True` (default) it waits for the controller to echo the slot back.
* `days` accepts day names/abbreviations (`mon`, `tuesday`), or the shortcuts
  `every` / `weekdays` / `weekends`. The raw day bitmask is always exposed on
  `Schedule.days_mask`.

> **Note:** the schedule day-bit ordering follows the common
> nodejs-poolController convention (Sun = bit 0 … Sat = bit 6). The raw byte is
> preserved so you can re-map if your controller differs.
>
> The status-only simulator on the dev bus does **not** serve or accept
> schedules, so `schedules` returns nothing and `set-schedule` cannot be
> confirmed against it. The encode/decode path is covered by unit tests
> (`tests/test_schedule.py`) and is correct for real EasyTouch hardware.

## HTTP JSON API

`serve` exposes **all** controller data and controls over a dependency-free
`http.server` JSON API on the LAN (no auth — keep it on a trusted network):

```bash
python -m easytouch --port socket://192.168.4.70:4000 serve --http-host 0.0.0.0 --http-port 8080
```

### Web dashboard

`serve` also hosts a **single-page dashboard** at the root URL — open
`http://<host>:8080/` in a browser. The source is TypeScript under `frontend/`,
bundled by Bun into `easytouch/static/` (`app.js` + `index.html`/`style.css`);
the committed build output is what the server ships, so **no Node/Bun is needed
at runtime** — only after editing `frontend/` (run `bun run build`). It polls
`GET /state` every ~3s (no manual refresh button — the header pill shows
freshness). There is no separate summary strip: the controls are the readings.
A freeze-protect / service-mode banner appears only when active; below it, one
flat titled section per control surface (no card chrome — inner tiles and
inputs carry their own affordances) — equipment (a full-width two-row band of
tap tiles, Pool/Spa first with a pending "confirming…" state; every
circuit is the same tap tile), a thermostat-style heat section (−/+ steppers that
auto-apply after a pause, segmented mode control — no Apply button), **salt /
chlorinator** (salt ppm with a color-coded low/OK/high verdict against the
IntelliChlor 3000–4500 ppm range; output % on the same −/+ auto-apply
steppers as heat), schedules (readable rows; "+ Add schedule" picks a free
controller slot automatically), and **pumps & clock** — a full-width band with
pump stats, the controller clock (inline sync icon), and the experimental Pump
Speed disclosure side by side; the **IntelliBrite lights** accordion sits
beneath it (native `<details>`, closed by default). The
unverified reverse-engineering surfaces
(IntelliChem, valves, circuit-name config — shown only when their data exists —
plus the raw/undecoded frames) are collapsed behind a **Diagnostics**
disclosure. Controls are editable inline; schedule writes — and the light /
pump / IntelliChem cards — are unverified on this controller, so they're
labelled *experimental*. Re-rendering pauses while a control is focused or was
just changed, so inputs never jump under you. If the bus goes silent for 30s
the server declares it dead, reconnects, and the pill turns red instead of
sitting on stale data. The JSON endpoint index moved to
`GET /api`; the page is a pure client of the data routes below.

### Salt / chlorinator

Salt level does **not** ride the A5 protocol — the IntelliChlor salt cell uses its
own DLE-framed messages on the same wire (`10 02 <dest> <cmd> <data…> <chk> 10
03`). `easytouch` runs a second framer (`easytouch/intellichlor.py`) over the raw
byte stream to decode it, so salt **ppm** and generation **output %** appear under
`GET /chlorinator` and in `/state`. Salt is reported in units of 50 ppm (the
on-wire byte × 50); the status byte is exposed raw, since its bit meanings aren't
reliably reverse-engineered. Verified live against the controller at **2750 ppm**.

### Architecture

The RS-485 bus is half-duplex with a **single** usable connection, so the server
must not open the port per request. One background thread (`BusMonitor`) owns the
connection, continuously decodes traffic into a cached snapshot, periodically
*requests* the sparse packet types (heat, schedules), and drains a command queue
so writes from any HTTP thread are serialized onto that single owner:

```
HTTP handlers ──read──► cached state ◄──updates── BusMonitor thread ──► serial/TCP
              └──enqueue command──► queue ──drained by──┘   (single bus owner)
```

### Endpoints

| Method | Path | Action |
|--------|------|--------|
| GET  | `/` | the web dashboard (HTML) |
| GET  | `/api` | endpoint index (JSON) |
| GET  | `/state` | full cached snapshot (decoded + raw + metadata) |
| GET  | `/status` `/heat` `/datetime` `/pumps` `/schedules` `/chlorinator` `/version` `/valves` `/intellichem` `/names` `/raw` | subsets of `/state` |
| GET  | `/circuit/<name-or-num>/<on\|off>` | turn a circuit on/off |
| GET  | `/heat/pool/<temp>` `/heat/spa/<temp>` | set a setpoint |
| GET  | `/chlorinator/output/<pct>` | set salt-cell generation output % |
| GET  | `/light/<command>` | IntelliBrite light command (`party`, `blue`, `on`, `off`, …) |
| POST | `/circuit` | `{"circuit": "pool", "on": true}` |
| POST | `/heat` | `{"pool_setpoint": 85, "spa_setpoint": 102, "pool_mode": 1, "spa_mode": 1}` |
| POST | `/schedule` | `{"id": 1, "circuit": "pool", "start": "08:00", "end": "10:30", "days": "mon,wed,fri"}` |
| POST | `/chlorinator` | `{"output": 40}` — set salt output % |
| POST | `/datetime` | `{"iso": "2026-06-14T11:30"}` (or `{}` for now) |
| POST | `/light` | `{"command": "party"}` |
| POST | `/pump` | `{"pump": 1, "rpm": 2400}` — **EXPERIMENTAL**, unverified |

Control endpoints enqueue the command, then poll the cache for confirmation:
they return **`200`** with the new state once the controller echoes the change,
or **`202 accepted`** if it hasn't within the confirm window.

```bash
curl -s localhost:8080/state | python -m json.tool
curl -s localhost:8080/heat
curl -s localhost:8080/heat/pool/85          # then check it changed; set back to 84
curl -s localhost:8080/circuit/pool/off
curl -s -XPOST localhost:8080/heat -d '{"spa_setpoint": 102, "spa_mode": 1}'
```

> **Coverage:** fully **decoded and validated** against real captured frames:
> controller status, date/time, heat, pump, schedule, and the IntelliChlor **salt
> level / output %**. Additionally decoded and surfaced but **not yet confirmed on
> this hardware** (reference-layout, best-effort, each carrying an authoritative
> `raw`): firmware **version** (`/version`), **valve** status (`/valves`),
> **IntelliChem** pH/ORP + setpoints (`/intellichem`), and **circuit-name config**
> ids (`/names`). Controls beyond circuit/heat/schedule: chlorinator **set-output**,
> **set clock**, IntelliBrite **lights**, and **pump RPM** (EXPERIMENTAL — contends
> with the controller). Any remaining undecoded CFIs stay as raw hex under `/raw`.

## Protocol summary

A5 frame on the wire:

```
[idle 0xFF ...] 0x00 0xFF | 0xA5 sub dst src cfi len <data...> ckh ckl
```

* **Addresses**: `0x0F` broadcast, `0x1x` main controllers, `0x2x` remotes,
  `0x6x` pumps.
* **Checksum**: 16-bit unsigned sum of the body (`0xA5` through last data byte),
  big-endian.
* Key actions (CFI): `2` controller status, `5` date/time, `7` pump status,
  `8` heat status, `11` circuit names, `17` schedule, `18` IntelliChem, `29` valve
  status, `96` set color (IntelliBrite), `133` set date/time, `134` set circuit,
  `136` set heat, `145` set schedule, `209` get schedule, `252` software version.

See `easytouch/protocol.py` and `easytouch/constants.py` for the full vocabulary,
and `PACKET_SPEC.txt` in the reference repo for the original reverse-engineering
notes.

## Project layout

| Path                      | Purpose                                             |
|---------------------------|-----------------------------------------------------|
| `easytouch/constants.py`  | Addresses, action codes, circuit/heat-mode tables   |
| `easytouch/protocol.py`   | `Packet`, checksum, single-frame encode/decode      |
| `easytouch/reader.py`     | `PacketReader` — streaming framer with resync        |
| `easytouch/decode.py`     | High-level decoders → typed status dataclasses      |
| `easytouch/controller.py` | `EasyTouch` serial client (monitor/snapshot/circuit/heat/schedule) |
| `easytouch/state.py`      | `BusMonitor` — single-owner bus thread + cached state |
| `easytouch/intellichlor.py` | IntelliChlor native-protocol framer + salt decode  |
| `easytouch/api.py`        | `serve()` — stdlib HTTP JSON API over the bus; serves the built dashboard |
| `easytouch/static/`       | Built dashboard bundle (`app.js` + `index.html`/`style.css`), committed |
| `frontend/`               | Dashboard source (TypeScript modules + CSS/HTML); `bun run build` |
| `easytouch/cli.py`        | `python -m easytouch` command-line interface        |
| `tools/mock_bus.py`       | Fake controller over TCP for hardware-free development |
| `tests/`                  | Unit tests against real captured frames             |
| `server/`                 | In-progress TypeScript port of the Python stack (see below) |

## Tests

```bash
pip install pytest
pytest
```

The tests decode real frames captured from the bus, so they guard against
protocol regressions without needing hardware.

## TypeScript port (in progress)

`server/` is an in-progress port of the Python stack to TypeScript with **zero
runtime dependencies**, so the whole thing can eventually run on `node` alone.
The Python package under `easytouch/` is still what the Pi runs; the port is not
deployed yet.

The API and CLI now work end-to-end. Run it exactly like the Python one:

```bash
bun server/cli.ts --port socket://127.0.0.1:4000 serve --http-port 8080
bun server/cli.ts --port /dev/ttyUSB0 status
bun run test          # server + frontend unit tests
bun run typecheck
```

Ported: protocol vocabulary, framer, decoders, IntelliChlor framer, transport
(`node:net` for `socket://`, `stty` + `node:fs` for a device path — no native
serial module), the single-owner `BusMonitor`, the HTTP JSON API (same routes,
same JSON, same 200/202/400/503 semantics) and the CLI.

Unlike the Python CLI, the TypeScript write commands drive a `BusMonitor` and
confirm against its cache — the same path the HTTP API uses — rather than a
second set of blocking request/confirm loops.

The tests reuse the same captured frames as the Python suite, and both stacks are
verified against `tools/mock_bus.py`; `GET /state` was compared key-for-key
between the two servers. Still to come: a bundled `dist/server.js`, the systemd
unit, and hardware verification — the device (`stty`) transport has no coverage
until it runs against a real adapter.

## Safety

Writing to the bus puts data on a shared RS-485 line. If you have a real
controller attached, sending commands can conflict with it. Test against the
simulator / PTY first, and make sure you can cut power to equipment by hand.

## Security

The HTTP API is **intentionally unauthenticated and LAN-only** — keep it on a
trusted network behind your router/firewall. An automated review flagged the usual
consequences of that posture, left in place by design:

- **CSRF** — state-changing GET endpoints (`/circuit/pool/off`, `/heat/pool/85`,
  `/chlorinator/output/40`, `/light/party`) mean any page on your LAN could
  actuate equipment via a plain `<img>`/form; there is no auth or CSRF token.
- **DNS rebinding** — the server does not validate the `Host` header and binds
  `0.0.0.0` by default.
- **Unbounded request body** — `POST` bodies are read without a size cap.

These are acceptable for the project's stated "LAN, no auth" design. If you expose
it more widely, add authentication, a `Host`/`Origin` allowlist, and a body-size
cap — e.g. behind a reverse proxy that adds auth and TLS.

## Credits

Protocol reverse-engineering from
[michaelusner/pentair-pool-controler](https://github.com/michaelusner/pentair-pool-controler)
and the field maps from
[tagyoureit/nodejs-poolController](https://github.com/tagyoureit/nodejs-poolController).

## License

MIT
