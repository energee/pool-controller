# Bus tap: consume (and command) the Pi's real RS-485 bus from another machine

Date: 2026-07-26
Status: approved (approach A), ready for implementation planning

## Problem

The RS-485 adapter is physically attached to the Raspberry Pi, and only one
process can open `/dev/ttyUSB0`. Today that process is the deployed dashboard
(`deploy/easytouch.service` → `python -m easytouch --port /dev/ttyUSB0 serve`).
A developer on another machine therefore has no access to real bus traffic and
must fall back to `tools/mock_bus.py`, which is synthetic by construction.

We want a dev machine at another IP to read real frames **and** send commands.

## What already exists

- **Both stacks already accept a network bus.** `easytouch/controller.py:83`
  resolves `socket://HOST:PORT` (and a `tcp://` alias) through
  `serial.serial_for_url`; `server/bus.ts` does the same over `node:net`. So the
  client side needs no transport work — only a `--port socket://pi.local:4001`.
- **`tools/mock_bus.py` is the precedent**: a TCP server in this repo that
  speaks the same raw byte stream a real bus does.
- **Two clean seams in the deployed Python monitor.** Every inbound byte arrives
  at one line (`easytouch/state.py:168`, `chunk = self._et.serial.read(...)`),
  and every outbound frame leaves through one queue (`_cmd_q`, drained by
  `_drain_commands` at `easytouch/state.py:295`).

## Approach: a tap inside the existing server

The Pi's `easytouch` process keeps owning `/dev/ttyUSB0`. An opt-in TCP listener
fans out what it reads and funnels what clients write into the queue it already
uses to serialize its own writes.

```
controller ──RS-485──> /dev/ttyUSB0 ──> _poll_once() reads chunk
                                          ├──> framers → decoded state (dashboard)
                                          └──> tap.broadcast(chunk) ──TCP──> dev clients

dev client ──TCP──> tap accept thread ──per-client buffer──> tap.take_writes()
                                                                  │
                                    dashboard set_*() ──> _cmd_q <─┘
                                                            │
                                                   _drain_commands() → serial.write()
```

### Why this one

Rejected alternatives, for the record:

- **`ser2net` owning the port** (zero code) would make an apt package a hard
  dependency of the deployed dashboard — a new single point of failure in a path
  that works today — and offers only best-effort write atomicity, since each
  client's bytes are forwarded with no shared queue.
- **A standalone `tools/bus_bridge.py`** adds that same single point of failure
  *and* the code, and only pays off if the Pi dashboard is later demoted to just
  another peer.

The in-server tap wins on two properties: write serialization is inherited from
the existing `_cmd_q` rather than reinvented, and a tap failure cannot affect the
dashboard, whose data path is unchanged.

## Components

### `easytouch/tap.py` (new)

A dependency-free TCP fan-out. Knows nothing about `BusMonitor`, framing, or the
protocol — it moves bytes and is testable on its own.

```python
class BusTap:
    def __init__(self, host: str, port: int, max_clients: int = 4) -> None: ...
    def start(self) -> "BusTap": ...          # bind + accept thread
    def stop(self) -> None: ...               # close listener and all clients
    def broadcast(self, chunk: bytes) -> None # to every client; drop dead ones
    def take_writes(self) -> list[bytes]      # bytes received since the last call
```

`take_writes()` is a **pull** interface, mirroring the existing
`BufferedLink.take()` idiom in `server/bus.ts`: the tap buffers, the poll loop
drains. This keeps `BusTap` free of any reference to the monitor or its queue.

### `easytouch/state.py` (~6 lines changed)

- `__init__(..., tap: BusTap | None = None)`
- `start()` / `stop()`: start and stop the tap alongside the bus thread
- `_poll_once()`: after the read, `if self._tap and chunk: self._tap.broadcast(chunk)`
- `_poll_once()`: before `_drain_commands()`, move `self._tap.take_writes()`
  onto `_cmd_q` so client frames are serialized with the dashboard's own

### `easytouch/cli.py`

- `--tap-port PORT` — **absent by default; no listener unless passed.**
- `--tap-host HOST` — default `0.0.0.0`, since the whole point is access from
  another IP. Startup logs one line stating the tap is unauthenticated LAN access.
- `--refresh-interval SECONDS` — client-side knob (see "Two pollers" below).
  The parameter already exists on `BusMonitor` in both stacks; only the CLIs fail
  to expose it. Two details the implementation must get right:

  - **Units differ between stacks.** `easytouch/state.py:87` takes
    `refresh_interval: float = 15.0` (*seconds*); `server/monitor.ts:123` takes
    `refreshInterval = 15_000` (*milliseconds*). The flag is in seconds in both
    CLIs, passed through in Python and multiplied by 1000 in TypeScript.
  - **`0` does not currently mean "disabled" — it means "every tick."** Both
    `_maybe_refresh` (`easytouch/state.py:272`) and `maybeRefresh`
    (`server/monitor.ts`) compute `next_refresh = now + interval`, so an interval
    of `0` refreshes on every poll: the opposite of the intent. Implementing
    `--refresh-interval 0` as "never auto-refresh" therefore requires an explicit
    guard at the top of both methods:
    `if self.refresh_interval <= 0: return`.

Add `--refresh-interval` to `server/cli.ts` as well: the dev machine may run
either stack, and it is the mitigation for the risk this design accepts.

## Two pollers on one half-duplex bus

Serialization solves interleaved frames. It does not solve **duplicate polling**:
each `BusMonitor` enqueues a Get-Heat plus a 12-slot schedule scan every 15s, and
this controller is documented in our own code as dropping bursts of back-to-back
Get-Schedule requests (`easytouch/state.py:207`). Two pollers would degrade both
ends' schedule reads.

Mitigation: run the dev client with `--refresh-interval 0`. It still sees
everything, because the Pi is already requesting heat/schedules and the
controller's replies travel the same wire. The dev box writes only when the
operator acts.

## Partial writes: the accepted ceiling

TCP can split a client's frame across two reads. The tap enqueues one queue item
per read, so a split frame is written as two `serial.write()` calls, and if a
dashboard command lands between them the halves are spliced.

This is acceptable and should carry a `ponytail:` comment naming the ceiling.
Both stacks write whole frames in a single `write()` (`Bus.send` →
`write(pkt.to_bytes(idle))`), so a ~20-byte frame effectively never splits; and
every reader in the system validates checksums and resyncs on garbage
(`easytouch/reader.py` skips a bad marker and rescans). The worst case is one
dropped command, not corrupt state.

Upgrade path if it ever bites: run `reader.PacketReader` and the IntelliChlor
framer over each client's stream and enqueue only complete frames.

## Error handling

The tap is non-essential; it must never take the bus down.

- Client disconnect or send failure → drop that client, keep the rest serving.
- `broadcast()` / `take_writes()` wrap per-client I/O so nothing propagates into
  the poll loop.
- Connection beyond `max_clients` → accept then immediately close, with a log line.
- Bind failure at startup → log an error and continue serving the dashboard
  without a tap. The dashboard is the priority; a bad `--tap-port` must not take
  the pool offline.

## Testing

`tests/test_tap.py`, using real loopback sockets on an ephemeral port:

1. `broadcast()` reaches two connected clients.
2. Bytes a client sends come back from `take_writes()` once; a second call is empty.
3. A disconnected client is dropped without raising and the other still receives.
4. The `max_clients` cap closes the extra connection.
5. `broadcast()` / `take_writes()` are no-ops with zero clients.

Integration, via the existing `tests/stub_serial.py`:

6. A `BusMonitor` with a tap forwards scripted stub bytes to a connected client.
7. Bytes a client sends reach `StubSerial.writes` after `_poll_once()`.

## Documentation

Per repo policy, in the same commit as the code:

- Module-level docstring in `easytouch/tap.py`.
- README: a "Develop against the real bus" section — the two commands (Pi with
  `--tap-port`, dev box with `socket://` and `--refresh-interval 0`) and the
  unauthenticated-LAN caveat.
- `deploy/easytouch.service`: a commented example showing where `--tap-port` goes.
- `HANDOFF.md`: note the tap and its accepted ceiling.

## Out of scope

- Mirroring **the tap** into `server/` (TypeScript). It exists to expose the Pi,
  and the Pi runs Python. Revisit if the TS stack is ever deployed. Note this
  excludes the `--refresh-interval` flag and its `<= 0` guard, which *are* added
  to both stacks (see Components) because either may be the dev client.
- Authentication or TLS on the tap. The HTTP API is already LAN-no-auth; the tap
  matches that stance and stays default-off.
- Arbitrating writes between clients beyond queue serialization (no leases or
  single-writer election).
