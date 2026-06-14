# easytouch — Session Handoff

Pick-up notes for resuming this project in a fresh session. Last updated during
the session that built the `easytouch` package (committed `f96bcda`).

---

## 1. TL;DR — where things stand

- **Built:** a lightweight Python toolkit (`easytouch/`) to monitor and control a
  Pentair EasyTouch controller over its RS-485 bus, using the reverse-engineered
  "A5" protocol from `michaelusner/pentair-pool-controler`.
- **Verified working:** the **read path** is validated live against the bus, and
  **23 unit tests pass** (frame encode/decode, streaming reader, status/date/pump
  decoders, and schedule encode/decode + Get/Set frame builders).
- **NOT yet verified:** the **write/control path** (circuit on/off, schedule
  get/set) end-to-end against a *writeable* bus. See §6 — this is the one open
  item.
- **Committed:** everything is in git on branch `main`, commit `f96bcda`.
  `HANDOFF.md` (this file) is the only addition after that.

---

## 2. The bus / how to connect

`/tmp/vserial` is a **PTY** created by `socat`, bridged to the actual bus over TCP:

```
socat -d -d PTY,link=/tmp/vserial,raw,echo=0,perm=0666 TCP:Teds-MacBook-Air.local:4000
```

- `/tmp/vserial` → `/dev/ttys016` (a symlink; the target ttys number can change
  if socat is restarted).
- Bus params: **9600 baud, 8N1**.
- `perm=0666` was added so the PTY is **writeable** (earlier it/the simulator was
  effectively read-only — see §6).
- If `/tmp/vserial` is missing on resume, the socat bridge isn't running — start
  it (the command above) or point `--port` at whatever device exposes the bus.

Quick liveness check:
```bash
./.venv/bin/python -m easytouch status --timeout 12
```

---

## 3. Resume / setup

```bash
cd /Users/tedslesinski/Repos/pool
python3 -m venv .venv && ./.venv/bin/python -m pip install -e . pytest
./.venv/bin/python -m pytest -q          # expect: 23 passed
```

(The `.venv/` already exists in this workspace and is git-ignored.)

---

## 4. What exists (project map)

| Path                      | Purpose |
|---------------------------|---------|
| `easytouch/constants.py`  | Addresses, action(CFI) codes, circuit + heat-mode + day tables |
| `easytouch/protocol.py`   | `Packet`, 16-bit checksum, single-frame encode/decode |
| `easytouch/reader.py`     | `PacketReader` — streaming framer w/ resync on garbage/bad checksum |
| `easytouch/decode.py`     | Typed decoders: `ControllerStatus`, `DateTime`, `PumpStatus`, `Schedule` (+ `Unknown` fallback); `encode_days`/`decode_days` |
| `easytouch/controller.py` | `EasyTouch` client: `packets()`, `snapshot()`, `set_circuit()`, `get_schedules()`, `set_schedule()` |
| `easytouch/cli.py`        | `python -m easytouch` CLI |
| `easytouch/__main__.py`   | `python -m easytouch` entry |
| `examples/monitor.py`     | Minimal live monitor script |
| `tests/test_protocol.py`  | Frame + reader tests (uses a real captured frame) |
| `tests/test_decode.py`    | Status/date/pump decode tests |
| `tests/test_schedule.py`  | Schedule encode/decode + Get/Set frame tests |

### CLI commands
```bash
python -m easytouch monitor            # stream decoded packets
python -m easytouch status             # one decoded snapshot (table)
python -m easytouch json               # one snapshot as JSON
python -m easytouch on  <pool|spa|aux1|6|...>
python -m easytouch off <...>
python -m easytouch schedules
python -m easytouch set-schedule --id 1 --circuit pool --start 08:00 --end 10:30 --days mon,wed,fri
python -m easytouch raw --seconds 5
python -m easytouch --port /dev/ttyUSB0 status   # different device
```

---

## 5. Verified live (read path)

A real status broadcast decodes to: `clock 11:01, pool 83°F, spa 83°F, air 82°F,
circuit 6 (pool) ON, heater ON, heat mode Heater`. The date/time packet decoded
to `2026-06-14` (matched the real date). Framing/checksum round-trips byte-for-byte.

---

## 6. OPEN ITEM — verify the write/control path  ⬅ start here

**Background:** while building, the endpoint behind TCP:4000 behaved as a
**status-only broadcaster** — over multi-second captures it emitted only:
- `CFI 2` Controller Status (equipment fixed at `200000` = circuit 6 on, clock advancing)
- `CFI 5` Date/Time

It **ignored** `set_circuit` writes (confirm timed out) and returned **nothing**
to a `Get Schedule` (CFI 209) request. So control could not be demonstrated
end-to-end. The control/schedule **frames are correct** (checksum round-trip unit
tested), just unconfirmable against that read-only source.

**The user then reported the bus is now writeable** (socat gained `perm=0666`).
The verification run to confirm this was **never captured** — it was launched as a
background job that piped `print()` to a file, and Python **block-buffers stdout
to a non-TTY**, so nothing flushed before the process ended. No results exist yet.

**To verify on resume — run this in the FOREGROUND with `-u` (unbuffered):**

```bash
cd /Users/tedslesinski/Repos/pool
./.venv/bin/python -u - <<'PY'
from easytouch import EasyTouch
with EasyTouch("/tmp/vserial") as et:
    s = et.snapshot(timeout=12)
    print("baseline:", s.clock, s.circuit_names, s.circuits_on, "sub=0x%02x" % et.controller_sub)
    target = 1 if 1 not in s.circuits_on else 2      # spa, else aux1
    try:
        r = et.set_circuit(target, True, timeout=12)
        print("ON  :", r.circuits_on, "CONFIRMED" if target in r.circuits_on else "NOT confirmed")
        r = et.set_circuit(target, False, timeout=12)
        print("OFF :", r.circuits_on, "CONFIRMED" if target not in r.circuits_on else "NOT confirmed")
    except TimeoutError as e:
        print("circuit TIMEOUT:", e)
    sch = et.get_schedules(timeout=6)
    print("schedules received:", len(sch))
    for x in sch: print("  #%d %s %s-%s %s" % (x.id, x.circuit_name, x.start, x.end, x.days))
    try:
        w = et.set_schedule(1, 6, "08:00", "10:30", ["mon","wed","fri"], timeout=8)
        print("set_schedule:", "CONFIRMED" if w else "sent", w)
    except TimeoutError as e:
        print("schedule TIMEOUT:", e)
PY
```

**Expected if the bus now actuates:** `CONFIRMED` on circuit ON and OFF; some
schedule packets returned and/or a confirmed `set_schedule`. If it still times
out, the TCP source accepts bytes but doesn't model actuation — next step would be
to write a small "fake controller" responder (see §8).

---

## 7. Protocol cheat-sheet (so you don't need the reference clone)

Reference repo was cloned to `/tmp/ref-pentair` (ephemeral — `/tmp` may be gone on
resume). Key files there: `PACKET_SPEC.txt`, `pool_controller.py`. Repo:
`https://github.com/michaelusner/pentair-pool-controler`.

**A5 frame on the wire:**
```
[idle 0xFF ...] 0x00 0xFF | 0xA5 sub dst src cfi len <data...> ckh ckl
```
- Checksum = 16-bit unsigned sum of body (`0xA5` … last data byte), big-endian.
- Field offsets are quoted from the full body (0xA5 = index 0); payload byte *n*
  is body offset *n+6*. `Packet.body_byte(n)` indexes that way.

**Addresses:** `0x0F` broadcast · `0x10` main controller · `0x20` remote (we send
as this) · `0x60+` pumps.

**Key CFIs:** `2` controller status · `5` date/time · `7` pump status · `8` heat
status · `17` schedule · `134` set circuit · `145` set schedule · `209` get schedule.

**Controller-status (CFI 2) field offsets (body index):** 6=hour, 7=min,
8/9/10=equip1/2/3 bitmasks, 15=runmode/UOM (bit 0x04=Celsius), 16=valve,
20=pool temp, 21=spa temp, 22=heater active (0=off/32=on), 24=air temp,
25=solar temp, 28=heat mode (pool=bits0-1, spa=bits2-3; 0 off/1 heater/2 solar pref/3 solar only).

**Equipment bitmask → circuits:** bit *i* (LSB) of equip1 = circuit *i+1*; equip2 = 9-16; equip3 = 17-24.

**Schedule (CFI 17 / set 145) layout (body index):** 6=id, 7=circuit (0=unused),
8=start hour, 9=start min, 10=stop hour, 11=stop min, 12=day bitmask.

**Real captured status frame (full, with 00FF preamble + checksum):**
```
00ffa5270f10021d0b0120000000000000200c000004535320005200000005000097a6030d03d0
```

**Default circuit numbers (EasyTouch convention, overridable):**
1=spa, 2-5=aux1-4, 6=pool, 7-10=feature1-4.

---

## 8. Possible next steps

1. **Verify write path** (§6) — the immediate open item.
2. If the source still doesn't actuate, build a **fake EasyTouch responder**
   (socat `TCP-LISTEN:4000` + a Python responder that serves status, accepts
   `set_circuit`/`set_schedule`, and echoes updated state) to demo the full
   round-trip green.
3. Decode more packet types: heat status (CFI 8) set-points, IntelliChlor
   (`0x10 0x02 … 0x10 0x03` framing — different from A5), pump config.
4. Optional integrations: MQTT/Home Assistant bridge over the `json` output.

---

## 9. Gotchas / conventions learned this session

- **ECC GateGuard hook** intercepts the *first* `Write`/`Edit` to each new file
  with a "fact-forcing" prompt — answer the 4 facts, then re-issue the identical
  call (it passes on retry). Disable via `ECC_GATEGUARD=off` or add
  `pre:edit-write:gateguard-fact-force` to `ECC_DISABLED_HOOKS`.
- **Cost guard hooks** fire warnings as the session runs; this session got
  expensive (~$68) — be deliberate.
- **Do NOT add `Co-Authored-By` trailers** to commits (user's global rule).
- `set_circuit`'s first transmit uses `default_sub=0x01`, then learns the
  controller's real sub (`0x27` observed) from the bus and re-sends. Calling
  `snapshot()` first primes it; usually not required since the confirm loop
  re-sends with the learned value.
- **Day-bit ordering** for schedules follows the nodejs-poolController convention
  (Sun=bit0 … Sat=bit6). It's a best-effort guess; `Schedule.days_mask` always
  carries the raw byte so it can be re-mapped if a real controller differs.
- Egg-timer schedules (run-for-duration) encode out-of-range hours; decode is
  literal — interpret raw bytes if you see odd times.
- Bus traffic is **bursty** (TCP-bridged), so reads can stall briefly; use
  generous timeouts (10-12s) for `snapshot()`/`status`.
- When scripting live checks, run **foreground + `python -u`** (or call
  `sys.stdout.flush()`); piping buffered stdout to a file loses output if the
  process is interrupted.
