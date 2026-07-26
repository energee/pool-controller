// A single owner of the RS-485 connection. Ported from easytouch/state.py.
//
// The bus is half-duplex with exactly **one** usable connection, so the HTTP API
// must not open the port per request. `BusMonitor` runs one poll loop that owns a
// `Bus`, continuously reads and decodes traffic into a cached, JSON-able snapshot,
// periodically *requests* the sparse packet types (heat, schedules), and drains a
// command queue so writes from any HTTP handler are serialized onto the single
// bus owner:
//
//     HTTP handlers ──read──> cached state  ◄──updates── poll loop ──> bus
//                   └──enqueue command──> queue ──drained by──┘
//
// Python used a daemon thread with a blocking 0.3s read; here the transport
// buffers into memory via events and `pollOnce()` drains it on a timer of the same
// period — so the poll-counted re-read windows below keep their original duration.
// Tests drive `pollOnce()` directly; production uses `start()`.

import { Bus, DEFAULT_BAUD, datetimeFields } from "./bus.js";
import * as C from "./constants.js";
import {
  type ControllerStatus,
  type HeatStatus,
  type Schedule,
  decode,
  encodeDays,
  mergeHeatMode,
} from "./decode.js";
import { ChlorinatorReader, buildSetOutput, decodeIc } from "./intellichlor.js";
import type { Packet } from "./protocol.js";

// EasyTouch stores 12 schedule slots (ids 1..12). The controller answers a
// Get-Schedule only for the slot id in the request — slot 0 is always empty — so
// every slot must be polled individually to discover the programmed schedules.
export const SCHEDULE_SLOTS = 12;

/** Poll period, matching pyserial's old blocking read timeout. */
export const POLL_INTERVAL_MS = 300;

type Command = Packet | Buffer;

export interface StateSnapshot {
  connected: boolean;
  error: string | null;
  last_packet_ts: number | null;
  age: number | null;
  status: ControllerStatus | null;
  heat: HeatStatus | null;
  datetime: unknown;
  version: unknown;
  valves: unknown;
  intellichem: unknown;
  names: Record<number, unknown>;
  pumps: Record<number, unknown>;
  schedules: Record<number, Schedule>;
  chlorinator: Record<string, unknown> | null;
  raw: Record<number, string>;
}

/**
 * Owns the bus connection and caches decoded state.
 *
 * State keys: `status` (CFI 2), `heat` (CFI 8), `datetime` (CFI 5), `pumps` (by
 * pump number), `schedules` (by id). Every decoded frame's raw hex is also kept
 * under `raw[cfi]` so undecoded packet types remain visible.
 */
export class BusMonitor {
  readonly bus: Bus; // public so tests can attach a scripted Link
  private state: Record<string, unknown> = {};
  private pumps: Record<number, unknown> = {};
  private schedules: Record<number, Schedule> = {};
  private names: Record<number, unknown> = {};
  private raw: Record<number, string> = {};
  // The salt chlorinator speaks its own (non-A5) protocol on the same wire; a
  // second framer over the raw byte stream decodes it into this object.
  private chlorReader = new ChlorinatorReader();
  private chlor: Record<string, unknown> = {};
  private chlorTs: number | null = null; // wall-clock of the last IC frame
  private cmdQueue: Command[] = [];
  connected = false;
  lastPacketTs: number | null = null;
  error: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextRefresh = 0; // ms deadline; 0 = refresh as soon as primed
  private primed = false; // true once a controller packet teaches us its sub
  // After a write, re-request the relevant status for this many polls so the cache
  // (and the HTTP confirm) reflects the change within the confirm window even if
  // the controller's first reply races ahead of applying the write.
  private heatReread = 0;
  private schedReread = 0;
  private schedRereadId = 1; // which slot the pending re-reads target
  // Schedule slots are polled one id at a time, paced — the controller drops a
  // burst of back-to-back Get-Schedule requests on the half-duplex bus.
  private schedScan: number[] = [];
  private nextSchedReq = 0; // ms gate for the next scan request
  schedReqGap = 1000; // ms between scan requests (0 in tests)

  constructor(
    port: string,
    baud: number = DEFAULT_BAUD,
    address: number = C.Address.REMOTE,
    public refreshInterval = 15_000
  ) {
    this.bus = new Bus(port, baud, address);
  }

  // --- lifecycle ---------------------------------------------------------
  start(): this {
    if (this.timer) return this;
    try {
      this.bus.open();
      this.connected = true;
    } catch (exc) {
      this.error = String((exc as Error).message ?? exc);
      this.connected = false;
    }
    this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.bus.close();
  }

  private tick(): void {
    let ok = false;
    try {
      ok = this.pollOnce();
    } catch (exc) {
      // Never kill the loop: report and fall through to the reconnect below.
      this.error = String((exc as Error).message ?? exc);
      this.connected = false;
    }
    if (!ok) this.reconnect();
  }

  private reconnect(): void {
    try {
      this.bus.close();
      this.bus.open();
      this.connected = true;
      this.error = null;
    } catch (exc) {
      this.error = String((exc as Error).message ?? exc);
      this.connected = false;
    }
  }

  // --- one read/ingest/refresh/drain cycle (also the unit-test seam) -----
  pollOnce(): boolean {
    let chunk: Buffer;
    try {
      chunk = this.bus.read();
    } catch (exc) {
      this.connected = false;
      this.error = String((exc as Error).message ?? exc);
      return false;
    }
    const failure = this.bus.failure();
    if (failure) {
      this.connected = false;
      this.error = failure;
      return false;
    }
    this.connected = true;
    this.error = null;
    for (const pkt of this.bus.feed(chunk)) this.ingest(pkt);
    for (const frame of this.chlorReader.feed(chunk)) this.ingestIc(frame);
    this.maybeRefresh();
    this.serviceSchedScan();
    this.serviceRereads();
    this.drainCommands();
    return true;
  }

  /** Re-request status types whose write is still being confirmed. */
  private serviceRereads(): void {
    if (!this.primed) return;
    if (this.heatReread > 0) {
      this.heatReread -= 1;
      this.cmdQueue.push(this.bus.buildGetHeat());
    }
    if (this.schedReread > 0) {
      this.schedReread -= 1;
      this.cmdQueue.push(this.bus.buildGetSchedules(this.schedRereadId));
    }
  }

  /**
   * Send one queued schedule-slot request per call, paced by a short gap.
   *
   * The controller drops a burst of back-to-back Get-Schedule requests on the
   * half-duplex bus (and answers only for the slot id asked), so the scan queued
   * by `maybeRefresh` is drained one id at a time.
   */
  private serviceSchedScan(): void {
    if (!this.primed || !this.schedScan.length) return;
    const now = performance.now();
    if (now < this.nextSchedReq) return;
    this.nextSchedReq = now + this.schedReqGap;
    this.cmdQueue.push(this.bus.buildGetSchedules(this.schedScan.shift()!));
  }

  private ingest(pkt: Packet): void {
    const obj = decode(pkt);
    switch (obj.kind) {
      case "status": this.state.status = obj.value; break;
      case "heat": this.state.heat = obj.value; break;
      case "datetime": this.state.datetime = obj.value; break;
      case "version": this.state.version = obj.value; break;
      case "valves": this.state.valves = obj.value; break;
      case "intellichem": this.state.intellichem = obj.value; break;
      case "pump": this.pumps[obj.value.pump] = obj.value; break;
      case "schedule": this.schedules[obj.value.id] = obj.value; break;
      case "names": this.names[obj.value.circuit] = obj.value; break;
      default: break; // Unknown: still recorded under raw[] below
    }
    this.raw[pkt.cfi] = pkt.toBytes(0).toString("hex");
    this.lastPacketTs = Date.now() / 1000;
    if (pkt.src === C.Address.MAIN) {
      // Bus.feed has now learned the controller's real sub from this frame, so
      // requests we send will be honored.
      this.primed = true;
    }
  }

  /**
   * Merge a decoded IntelliChlor frame into the cached chlorinator state.
   *
   * Salt and status arrive in the chlorinator's status frame (cmd 0x12); the
   * requested output % rides a separate set-output frame (cmd 0x11), so the two are
   * merged field-by-field rather than replaced wholesale.
   */
  private ingestIc(frame: Parameters<typeof decodeIc>[0]): void {
    const obj = decodeIc(frame);
    if (!obj) return;
    if (obj.kind === "status") {
      this.chlor.salt_ppm = obj.value.salt_ppm;
      this.chlor.status_flags = obj.value.status_flags;
    } else {
      this.chlor.output_percent = obj.value.output_percent;
    }
    const now = Date.now() / 1000;
    this.chlorTs = now; // for the "last seen" / staleness display
    this.lastPacketTs = now;
  }

  /**
   * Periodically request the sparse packet types (heat, schedules).
   *
   * Held off until a controller packet has taught us the real sub-version — the
   * controller ignores requests stamped with the default sub, so an early refresh
   * would just be wasted.
   */
  private maybeRefresh(): void {
    if (!this.primed) return;
    const now = performance.now();
    if (now < this.nextRefresh) return;
    this.nextRefresh = now + this.refreshInterval;
    this.cmdQueue.push(this.bus.buildGetHeat());
    if (!("version" in this.state)) this.cmdQueue.push(this.bus.buildGetVersion()); // static; ask until seen
    // Queue a full schedule re-scan. The controller answers only for the id in the
    // request (a single id-0 request never surfaces slots 1..N) and drops a burst of
    // requests, so slots are polled one at a time, paced, by serviceSchedScan. Delay
    // the first slot by one gap so it is not bundled into this same drain as
    // Get-Heat (that burst loses slot 1).
    this.schedScan = Array.from({ length: SCHEDULE_SLOTS }, (_, i) => i + 1);
    this.nextSchedReq = now + this.schedReqGap;
  }

  private drainCommands(): void {
    while (this.cmdQueue.length) {
      const cmd = this.cmdQueue.shift()!;
      try {
        // Most commands are A5 Packets; IntelliChlor frames are pre-built raw bytes
        // (its native protocol) and go out verbatim.
        if (Buffer.isBuffer(cmd)) this.bus.sendRaw(cmd);
        else this.bus.send(cmd);
      } catch (exc) {
        this.error = String((exc as Error).message ?? exc);
      }
    }
  }

  // --- reads -------------------------------------------------------------
  /** A JSON-able snapshot of decoded state, raw frames, and metadata. */
  getState(): StateSnapshot {
    const now = Date.now() / 1000;
    const chlor = Object.keys(this.chlor).length ? { ...this.chlor } : null;
    // Stamp the chlorinator with how long ago it last spoke, so the UI can show
    // staleness instead of silently vanishing when the cell goes quiet (it only
    // reports while the pool is running).
    if (chlor) {
      chlor.last_seen_ts = this.chlorTs;
      chlor.age = this.chlorTs === null ? null : now - this.chlorTs;
    }
    return {
      connected: this.connected,
      error: this.error,
      last_packet_ts: this.lastPacketTs,
      age: this.lastPacketTs === null ? null : now - this.lastPacketTs,
      status: (this.state.status as ControllerStatus) ?? null,
      heat: (this.state.heat as HeatStatus) ?? null,
      datetime: this.state.datetime ?? null,
      version: this.state.version ?? null,
      valves: this.state.valves ?? null,
      intellichem: this.state.intellichem ?? null,
      names: { ...this.names },
      pumps: { ...this.pumps },
      schedules: { ...this.schedules },
      chlorinator: chlor,
      raw: { ...this.raw },
    };
  }

  /** Poll `getState()` until `predicate` holds; resolve with it, else null. */
  async waitFor(
    predicate: (s: StateSnapshot) => boolean,
    timeoutMs = 6000,
    intervalMs = 100
  ): Promise<StateSnapshot | null> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const st = this.getState();
      if (predicate(st)) return st;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    const st = this.getState();
    return predicate(st) ? st : null;
  }

  // --- commands (enqueued; the single bus owner sends them) --------------
  setCircuit(circuit: number, on: boolean): void {
    this.cmdQueue.push(this.bus.buildSetCircuit(circuit, Boolean(on)));
  }

  /**
   * Enqueue an IntelliChlor Set-Output (raw native frame); return the clamped %.
   *
   * The cell's status frame (cmd 0x12) carries salt but not output, so the
   * requested value is cached optimistically here for the UI; the next observed
   * controller set-output frame (cmd 0x11) corrects it. Best-effort — a present
   * EasyTouch controller may override a direct injection (see HANDOFF).
   */
  setChlorinatorOutput(percent: number): number {
    const pct = Math.max(0, Math.min(100, Math.trunc(percent)));
    this.cmdQueue.push(buildSetOutput(pct));
    this.chlor.output_percent = pct;
    return pct;
  }

  /** Enqueue a Set-Date/Time (defaults to the host's current local time). */
  setDatetime(when?: Date | null, autoDst = true): Record<string, unknown> {
    const [h, m, dow, day, mon, yr, dst] = datetimeFields(when, autoDst);
    this.cmdQueue.push(this.bus.buildSetDatetime(h, m, dow, day, mon, yr, dst));
    return { hour: h, minute: m, dow, day, month: mon, year: 2000 + yr, auto_dst: Boolean(dst) };
  }

  /** Enqueue an IntelliBrite light command; returns the resolved code. */
  setLight(command: string | number): number {
    const code = C.resolveLightCommand(command);
    this.cmdQueue.push(this.bus.buildSetLight(code));
    return code;
  }

  /**
   * EXPERIMENTAL pump RPM command. Enqueues remote-control + set-speed frames.
   * Unverified and may contend with the controller's own pump programs.
   */
  setPumpSpeed(pump: number, rpm: number): Record<string, unknown> {
    this.cmdQueue.push(this.bus.buildPumpRemoteControl(pump, true));
    this.cmdQueue.push(this.bus.buildSetPumpSpeed(pump, rpm));
    return { pump, rpm, experimental: true };
  }

  /**
   * Enqueue a Set-Heat built from the cached heat status (read-modify-write).
   * Throws if no heat status has been cached yet.
   */
  setHeat(
    poolSetpoint?: number | null,
    spaSetpoint?: number | null,
    poolMode?: number | null,
    spaMode?: number | null
  ): Record<string, number> {
    const cur = this.state.heat as HeatStatus | undefined;
    if (!cur) throw new Error("no heat status cached yet; try again shortly");
    const psp = poolSetpoint ?? cur.pool_setpoint;
    const ssp = spaSetpoint ?? cur.spa_setpoint;
    const mode = mergeHeatMode(cur.heat_mode_raw, poolMode, spaMode);
    this.cmdQueue.push(this.bus.buildSetHeat(psp, ssp, mode));
    // Heat status isn't broadcast unsolicited, so re-request it across the next
    // several polls — one immediate read can race the controller's apply.
    this.heatReread = 20;
    return { pool_setpoint: psp, spa_setpoint: ssp, heat_mode: mode };
  }

  setSchedule(
    scheduleId: number,
    circuit: number,
    start: string,
    end: string,
    days: string | string[] | number
  ): void {
    const mask = typeof days === "number" ? days : encodeDays(days);
    this.cmdQueue.push(this.bus.buildSetSchedule(scheduleId, circuit, start, end, mask));
    this.schedReread = 12; // re-read across the confirm window
    this.schedRereadId = scheduleId; // ...the slot we just wrote
  }
}
