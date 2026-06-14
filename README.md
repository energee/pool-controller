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
pip install -e .          # or: pip install -r requirements.txt
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

    for pkt in et.packets():               # stream every decoded packet
        print(pkt)
```

Decoders return typed dataclasses (`ControllerStatus`, `DateTime`, `PumpStatus`,
`Schedule`) or an `Unknown` wrapper for frames without a dedicated decoder, so
monitoring never silently drops traffic.

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
  `8` heat status, `17` schedule, `134` set circuit, `145` set schedule,
  `209` get schedule.

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
| `easytouch/controller.py` | `EasyTouch` serial client (monitor / snapshot / set)|
| `easytouch/cli.py`        | `python -m easytouch` command-line interface        |
| `examples/monitor.py`     | Minimal live-monitor script                         |
| `tests/`                  | Unit tests against real captured frames             |

## Tests

```bash
pip install pytest
pytest
```

The tests decode real frames captured from the bus, so they guard against
protocol regressions without needing hardware.

## Safety

Writing to the bus puts data on a shared RS-485 line. If you have a real
controller attached, sending commands can conflict with it. Test against the
simulator / PTY first, and make sure you can cut power to equipment by hand.

## Credits

Protocol reverse-engineering from
[michaelusner/pentair-pool-controler](https://github.com/michaelusner/pentair-pool-controler)
and the field maps from
[tagyoureit/nodejs-poolController](https://github.com/tagyoureit/nodejs-poolController).

## License

MIT
