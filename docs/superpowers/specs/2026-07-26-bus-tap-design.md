# Move the Pi to the TypeScript stack, then tap the bus

Date: 2026-07-26
Status: approved in shape (TS stack on the Pi, in-server tap); ready for planning

## Problem

The RS-485 adapter is attached to the Raspberry Pi and only one process can open
`/dev/ttyUSB0`. A developer on another machine has no access to real bus traffic
and must use `tools/mock_bus.py`, which is synthetic by construction. We want a
dev machine at another IP to read real frames **and** send commands, and we want
it built in TypeScript.

Building it in TypeScript couples it to a deployment change: a TS tap only sees
the bus if the TS stack owns the port on the Pi. Today `deploy/easytouch.service`
runs Python, README:86-88 promises "**no Node/Bun on the Pi**", and PR #1 still
carries "TS stack on real hardware — explicitly **not** claimed working yet".

## Two phases, landed separately

**Phase 1 — the TS stack runs on the Pi.** All of the risk lives here. Ships as
its own PR and must be verified against real hardware before cutover.

**Phase 2 — the bus tap.** Small, additive, and only useful once Phase 1 is live.

Phase 2 must not be started before Phase 1 is verified on the physical bus.

---

# Phase 1 — TS stack on the Pi

## What has to exist

1. **A server bundle.** `package.json` has only a frontend build. Add:
   `bun build server/cli.ts --target node --outfile dist/easytouch.js`.
   `server/` has zero runtime dependencies, so this should bundle to one file
   runnable by plain `node` — matching the port's stated intent (no Bun, no
   node-gyp on the Pi).

2. **Verify `STATIC_DIR` survives bundling.** `server/api.ts:46` computes
   `resolve(dirname(fileURLToPath(import.meta.url)), "..", "easytouch", "static")`.
   From `dist/easytouch.js` that resolves to `<repo>/easytouch/static`, which is
   correct — but it is resolution-dependent and must be asserted, not assumed. If
   the bundler rewrites `import.meta.url`, the dashboard serves 404s for its own
   JS while the API still answers, which is a confusing failure. Add a smoke check
   that `GET /` returns HTML and `GET /static/app.js` returns JavaScript from the
   bundled artifact.

3. **Node on the Pi.** Node ≥ 20. Update README's "no Node/Bun on the Pi" claim,
   which becomes false for the TS deployment path.

4. **`deploy/easytouch-ts.service`**, mirroring the existing unit: `User=pi`,
   `SupplementaryGroups=dialout`, `Restart=on-failure`, `After=network-online.target`,
   `ExecStart=/usr/bin/node /home/pi/pool/dist/easytouch.js --port /dev/ttyUSB0 serve --http-port 8080`.
   The existing Python unit stays installed and unmodified as the rollback target.

## The risk that matters

`openDevice` (`server/bus.ts`) configures the line with `stty` and then reads the
device with `createReadStream`. **Reading a serial character device through an
`fs` stream is the part least likely to work first try** — the plausible failure
is the stream emitting `end`/EOF or delivering nothing, rather than tailing the
device indefinitely.

Two things make this cheap to detect. The `stty` flag is already correct for the
Pi (`process.platform === "linux"` → `-F`, fixed earlier). And the silent-bus
detector (`STALE_AFTER_S = 30`) turns a dead transport into a visible
`connected: false` plus an error string rather than a silent hang.

Fallback if `createReadStream` misbehaves: replace it with an explicit
`fs.read()` loop on a descriptor opened non-blocking, keeping the `Link`
interface unchanged so nothing above the transport notices.

## Verification protocol (before any cutover)

Only one process can hold the port, so this is a short scheduled window, not a
side-by-side run:

1. `sudo systemctl stop easytouch` — Python releases the port.
2. `node dist/easytouch.js --port /dev/ttyUSB0 serve --http-port 8081` in the
   foreground, on a *different* HTTP port so nothing else is disturbed.
3. Confirm, against the real controller:
   - `GET /state` decodes: status, clock, temps, pump, salt.
   - `GET /heat` populates (proves request/response, not just broadcasts).
   - Schedules populate across a full paced scan (~13s).
   - One reversible write confirms — e.g. toggle an aux circuit on and back off.
   - `GET /` and `GET /static/app.js` serve the dashboard (item 2 above).
4. Compare `/state` key-for-key against the Python output captured before the
   window. PR #1 already did this against the mock bus; this repeats it on hardware.
5. `Ctrl-C`, then `sudo systemctl start easytouch`. The pool is back on Python
   regardless of the outcome.

Cutover only if step 3 and 4 pass:
`sudo systemctl disable --now easytouch && sudo systemctl enable --now easytouch-ts`

Rollback, at any later point:
`sudo systemctl disable --now easytouch-ts && sudo systemctl enable --now easytouch`

## Phase 1 out of scope

- Removing or deprecating the Python stack. It stays as the reference
  implementation and the rollback target.
- Any tap functionality.

---

# Phase 2 — the bus tap (TypeScript)

## Approach

The TS server owns `/dev/ttyUSB0` and serves the dashboard. An opt-in TCP
listener fans out what it reads, and funnels what clients write into the queue it
already uses to serialize its own writes.

```
controller ──RS-485──> /dev/ttyUSB0 ──> pollOnce(): chunk = bus.read()
                                          ├──> bus.feed(chunk) → decoded state
                                          └──> tap.broadcast(chunk) ──TCP──> dev clients

dev client ──TCP──> tap ──buffer──> tap.take() ──> cmdQueue ──> drainCommands()
                                                      ▲              │
                              dashboard set*() ───────┘        bus.sendRaw()
```

Both seams already exist in `server/monitor.ts`: `pollOnce()` reads one chunk via
`this.bus.read()`, and `cmdQueue` (typed `Packet | Buffer`, drained by
`drainCommands()`, which routes `Buffer` to `bus.sendRaw()`) is already the single
writer. Client frames are raw bytes, so they ride the `Buffer` branch unchanged.

Rejected alternatives: `ser2net` owning the port makes an apt package a hard
dependency of the deployed data path and offers only best-effort write atomicity,
with no shared queue. A standalone bridge process adds a failure point without
removing any code.

## Components

### `server/tap.ts` (new)

A dependency-free `node:net` fan-out that knows nothing about `BusMonitor`,
framing, or the protocol. Deliberately mirrors the existing `BufferedLink` idiom
in `server/bus.ts` — buffer inbound bytes, hand them over on a pull — so it is
testable with no monitor and holds no reference to the queue.

```ts
export class BusTap {
  constructor(host: string, port: number, maxClients = 4) {}
  start(): this          // listen + accept
  stop(): void           // close listener and every client
  broadcast(chunk: Buffer): void   // to all clients; drop dead ones
  take(): Buffer[]       // bytes received since the last call
}
```

### `server/monitor.ts` (~6 lines)

- Constructor accepts an optional `tap: BusTap | null`.
- `start()` / `stop()` start and stop it alongside the poll timer.
- `pollOnce()`: after the read, `if (this.tap && chunk.length) this.tap.broadcast(chunk)`.
- `pollOnce()`: before `drainCommands()`, push `this.tap.take()` onto `cmdQueue`.

### `server/cli.ts` + `server/api.ts`

- `--tap-port PORT` — **absent by default; no listener unless passed.**
- `--tap-host HOST` — default `0.0.0.0`, since the point is access from another
  IP. Log one startup line stating the tap is unauthenticated LAN access.
- `--refresh-interval SECONDS` — see below. `serve()` already takes
  `refreshInterval`; only the CLI fails to expose it.

## Two pollers on one half-duplex bus

Queue serialization prevents interleaved frames. It does not prevent **duplicate
polling**: each `BusMonitor` enqueues a Get-Heat plus a 12-slot schedule scan
every 15s, and this controller is documented in our own code as dropping bursts
of back-to-back Get-Schedule requests (`server/monitor.ts`, `serviceSchedScan`).
Two pollers would degrade both ends' schedule reads.

Mitigation: run the dev client with `--refresh-interval 0`. It still sees
everything, because the Pi is already requesting heat and schedules and the
controller's replies travel the same wire. The dev box writes only on operator
action.

Two implementation details, both verified against the code:

- **`0` does not currently mean "disabled" — it means "every tick."**
  `maybeRefresh()` computes `nextRefresh = now + refreshInterval`, so `0`
  refreshes on every poll: the opposite of the intent. `--refresh-interval 0`
  requires an explicit guard at the top of `maybeRefresh()`:
  `if (this.refreshInterval <= 0) return;`
- **Units.** `server/monitor.ts:123` is milliseconds (`refreshInterval = 15_000`);
  the flag is seconds, so the CLI multiplies by 1000. (`easytouch/state.py:87`
  takes seconds — relevant only if a Python client is used.)

## Partial writes: the accepted ceiling

TCP can split a client's frame across two reads. The tap enqueues one item per
read, so a split frame becomes two `sendRaw()` calls, and if a dashboard command
lands between them the halves are spliced.

This is acceptable and carries a `ponytail:` comment naming the ceiling. Both
stacks write whole frames in a single call (`Bus.send` → `write(pkt.toBytes(idle))`),
so a ~20-byte frame effectively never splits; and every reader validates
checksums and resyncs on garbage (`server/reader.ts` skips a bad marker and
rescans). Worst case is one dropped command, not corrupt state.

Upgrade path if it ever bites: run `PacketReader` and the IntelliChlor framer over
each client's stream and enqueue only complete frames.

## Error handling

The tap is non-essential and must never take the bus down.

- Client disconnect or write failure → drop that client, keep the rest serving.
- `broadcast()` / `take()` contain their per-client I/O so nothing propagates into
  the poll loop.
- Connections beyond `maxClients` → accept then immediately destroy, with a log line.
- Listen failure at startup → log an error and keep serving the dashboard. A bad
  `--tap-port` must not take the pool offline.

## Testing

`server/tap.test.ts`, on loopback with an ephemeral port:

1. `broadcast()` reaches two connected clients.
2. Bytes a client sends come back from `take()` once; a second call is empty.
3. A disconnected client is dropped without throwing; the other still receives.
4. The `maxClients` cap destroys the extra connection.
5. `broadcast()` / `take()` are no-ops with zero clients.

Integration, via the existing `StubLink` in `server/testing.ts`:

6. A `BusMonitor` with a tap forwards scripted stub bytes to a connected client.
7. Bytes a client sends reach `StubLink.writes` after `pollOnce()`.

Plus a unit test for the `refreshInterval <= 0` guard: `maybeRefresh()` enqueues
nothing across several polls.

## Documentation

Same commit as the code, per repo policy:

- Module-level comment in `server/tap.ts`.
- README: a "Develop against the real bus" section — the Pi command with
  `--tap-port`, the dev command with `socket://` and `--refresh-interval 0`, and
  the unauthenticated-LAN caveat. Also correct the "no Node/Bun on the Pi" claim
  (Phase 1).
- `deploy/easytouch-ts.service`: commented example showing where `--tap-port` goes.
- `HANDOFF.md`: the tap, its accepted ceiling, and the new deployment shape.

## Phase 2 out of scope

- Backporting the tap to `easytouch/` (Python). It exists to expose whichever
  stack owns the port, and after Phase 1 that is TypeScript.
- Authentication or TLS. The HTTP API is already LAN-no-auth; the tap matches
  that stance and stays default-off.
- Arbitrating writes between clients beyond queue serialization — no leases, no
  single-writer election.
