#!/usr/bin/env node
// Command-line interface for the EasyTouch bus. Ported from easytouch/cli.py.
//
//     serve         run the HTTP JSON API (owns the bus)
//     status        print one decoded system snapshot as a table
//     json          print one snapshot as JSON (good for scripting)
//     monitor       stream decoded bus traffic
//     raw           dump raw hex frames (debugging)
//     on <circ>     turn a circuit on  (name or number)
//     off <circ>    turn a circuit off
//     schedules     view stored schedules
//     set-schedule  write a schedule slot
//     heat          print heat/temperature status
//     set-heat      set heat set-points and/or modes
//     set-chlor     set IntelliChlor generation output %
//     set-clock     set the controller clock (default: now)
//     light         send an IntelliBrite light command (theme/color/on/off)
//     set-pump      EXPERIMENTAL: command a pump RPM (unverified)
//
// Unlike the Python CLI, the write commands here drive a BusMonitor and confirm
// against its cache — the same path the HTTP API uses — instead of a second set of
// blocking request/confirm loops. One bus owner, one confirmation strategy.

import { DEFAULT_BAUD, DEFAULT_PORT, resolveCircuit } from "./bus.js";
import { serve } from "./api.js";
import { BusMonitor, SCHEDULE_SLOTS, type StateSnapshot, confirmed } from "./monitor.js";
import { decode } from "./decode.js";
import { parseFrame } from "./protocol.js";
import { Address } from "./constants.js";

interface Opts {
  port: string;
  baud: number;
  seconds: number;
  httpHost: string;
  httpPort: number;
  rest: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): { cmd: string; opts: Opts } {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) flags[arg.slice(2)] = argv[++i] ?? "";
    else rest.push(arg);
  }
  const cmd = rest.shift() ?? "status";
  return {
    cmd,
    opts: {
      port: flags.port ?? process.env.EASYTOUCH_PORT ?? DEFAULT_PORT,
      baud: Number(flags.baud ?? DEFAULT_BAUD),
      seconds: Number(flags.seconds ?? 0),
      httpHost: flags["http-host"] ?? "0.0.0.0",
      httpPort: Number(flags["http-port"] ?? 8080),
      rest,
      flags,
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run a BusMonitor for the duration of `fn`, then stop it and exit. */
async function withMonitor<T>(opts: Opts, fn: (m: BusMonitor) => Promise<T>): Promise<T> {
  const mon = new BusMonitor(opts.port, opts.baud, Address.REMOTE).start();
  try {
    return await fn(mon);
  } finally {
    mon.stop();
  }
}

/** Wait for the first snapshot carrying `key`, or throw after `timeout` ms. */
async function firstOf(
  mon: BusMonitor,
  key: keyof StateSnapshot,
  timeout = 10_000
): Promise<StateSnapshot> {
  const st = await mon.waitFor((s) => s[key] != null, timeout);
  if (!st) throw new Error(`no ${String(key)} within ${timeout / 1000}s`);
  return st;
}

function printStatus(s: NonNullable<StateSnapshot["status"]>): void {
  const circuits = s.circuit_names.length ? s.circuit_names.join(", ") : "(all off)";
  console.log(`  Clock        : ${s.clock}`);
  console.log(`  Circuits on  : ${circuits}  [${s.circuits_on}]`);
  console.log(`  Pool temp    : ${s.pool_temp}°${s.unit}`);
  console.log(`  Spa temp     : ${s.spa_temp}°${s.unit}`);
  console.log(`  Air temp     : ${s.air_temp}°${s.unit}`);
  console.log(`  Solar temp   : ${s.solar_temp}°${s.unit}`);
  console.log(`  Heater       : ${s.heater_on ? "ON" : "off"}`);
  console.log(`  Heat mode    : pool=${s.pool_heat_mode}  spa=${s.spa_heat_mode}`);
  if (s.service) console.log("  Mode         : SERVICE");
  if (s.freeze) console.log("  Freeze       : ACTIVE");
}

async function main(): Promise<number> {
  const { cmd, opts } = parseArgs(process.argv.slice(2));

  if (cmd === "serve") {
    serve({
      port: opts.port, baud: opts.baud, httpHost: opts.httpHost, httpPort: opts.httpPort,
    });
    return -1; // stays running until SIGINT
  }

  if (cmd === "status") {
    return withMonitor(opts, async (mon) => {
      console.log(`EasyTouch status @ ${opts.port}:`);
      printStatus((await firstOf(mon, "status")).status!);
      return 0;
    });
  }

  if (cmd === "json") {
    return withMonitor(opts, async (mon) => {
      await firstOf(mon, "status");
      // Give the sparse types (heat, schedules) one refresh cycle to arrive.
      await sleep(2000);
      console.log(JSON.stringify(mon.getState(), null, 2));
      return 0;
    });
  }

  if (cmd === "monitor" || cmd === "raw") {
    return withMonitor(opts, async (mon) => {
      console.log(`Monitoring ${opts.port} (Ctrl-C to stop)...`);
      const seen = new Set<string>();
      const deadline = opts.seconds ? Date.now() + opts.seconds * 1000 : Infinity;
      while (Date.now() < deadline) {
        for (const [cfi, hex] of Object.entries(mon.getState().raw)) {
          const key = `${cfi}:${hex}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const ts = new Date().toTimeString().slice(0, 8);
          if (cmd === "raw") console.log(`[${ts}] ${hex}`);
          else {
            try {
              const pkt = parseFrame(Buffer.from(hex, "hex"));
              console.log(`[${ts}] ${String(decode(pkt).kind)} ${String(pkt)}`);
            } catch {
              console.log(`[${ts}] ${hex}`); // shouldn't happen: raw[] holds validated frames
            }
          }
        }
        await sleep(300);
      }
      return 0;
    });
  }

  if (cmd === "on" || cmd === "off") {
    const circuit = resolveCircuit(opts.rest[0] ?? "");
    return withMonitor(opts, async (mon) => {
      await firstOf(mon, "status");
      mon.setCircuit(circuit, cmd === "on");
      const st = await mon.waitFor(confirmed.circuit(circuit, cmd === "on"), 8000);
      console.log(st ? `circuit ${circuit} is ${cmd}` : `circuit ${circuit} not confirmed`);
      if (st?.status) printStatus(st.status);
      return st ? 0 : 1;
    });
  }

  if (cmd === "heat") {
    return withMonitor(opts, async (mon) => {
      const h = (await firstOf(mon, "heat", 12_000)).heat!;
      console.log(`  Pool  : ${h.pool_temp}° (set ${h.pool_setpoint}°)  ${h.pool_heat_mode}`);
      console.log(`  Spa   : ${h.spa_temp}° (set ${h.spa_setpoint}°)  ${h.spa_heat_mode}`);
      console.log(`  Air   : ${h.air_temp}°`);
      return 0;
    });
  }

  if (cmd === "set-heat") {
    const num = (k: string) => (opts.flags[k] == null ? undefined : Number(opts.flags[k]));
    return withMonitor(opts, async (mon) => {
      await firstOf(mon, "heat", 12_000);
      const res = mon.setHeat(num("pool"), num("spa"), num("pool-mode"), num("spa-mode"));
      const st = await mon.waitFor(confirmed.heat(res), 8000);
      console.log(st ? `confirmed: ${JSON.stringify(st.heat)}` : `sent (unconfirmed): ${JSON.stringify(res)}`);
      return st ? 0 : 1;
    });
  }

  if (cmd === "schedules") {
    return withMonitor(opts, async (mon) => {
      await firstOf(mon, "status");
      // Slots are polled one at a time, paced schedReqGap apart; wait out a full
      // scan plus a little margin for the replies.
      await sleep((SCHEDULE_SLOTS + 3) * mon.schedReqGap);
      const scheds = Object.values(mon.getState().schedules).filter((s) => s.active);
      if (!scheds.length) {
        console.log("no schedules programmed");
        return 0;
      }
      for (const s of scheds.sort((a, b) => a.id - b.id)) {
        console.log(`  ${s.id}: ${s.circuit_name.padEnd(8)} ${s.start}-${s.end}  ${s.days.join(",")}`);
      }
      return 0;
    });
  }

  if (cmd === "set-schedule") {
    const { flags } = opts;
    return withMonitor(opts, async (mon) => {
      await firstOf(mon, "status");
      const id = Number(flags.id);
      mon.setSchedule(
        id, resolveCircuit(flags.circuit ?? ""), flags.start ?? "", flags.end ?? "",
        flags.days ?? "every"
      );
      const st = await mon.waitFor(confirmed.schedule(id), 15_000);
      console.log(st ? `confirmed: ${JSON.stringify(st.schedules[id])}` : "sent (unconfirmed)");
      return st ? 0 : 1;
    });
  }

  if (cmd === "set-chlor") {
    return withMonitor(opts, async (mon) => {
      await firstOf(mon, "status");
      const pct = mon.setChlorinatorOutput(Number(opts.flags.percent));
      await mon.flush(); // the poll loop drains the queue onto the bus
      console.log(`sent: output ${pct}% (best-effort; the controller may override)`);
      return 0;
    });
  }

  if (cmd === "set-clock") {
    return withMonitor(opts, async (mon) => {
      await firstOf(mon, "status");
      const res = mon.setDatetime(opts.flags.when ? new Date(opts.flags.when) : null);
      const st = await mon.waitFor(confirmed.datetime(res), 8000);
      console.log(st ? `confirmed: ${JSON.stringify(st.datetime)}` : `sent (unconfirmed): ${JSON.stringify(res)}`);
      return st ? 0 : 1;
    });
  }

  if (cmd === "light") {
    return withMonitor(opts, async (mon) => {
      await firstOf(mon, "status");
      const code = mon.setLight(opts.rest[0] ?? "");
      await mon.flush();
      console.log(`sent light command ${opts.rest[0]} (code ${code}) — no status to confirm against`);
      return 0;
    });
  }

  if (cmd === "set-pump") {
    return withMonitor(opts, async (mon) => {
      await firstOf(mon, "status");
      const res = mon.setPumpSpeed(Number(opts.flags.pump ?? 1), Number(opts.flags.rpm));
      await mon.flush();
      console.log(`sent (EXPERIMENTAL, unverified): ${JSON.stringify(res)}`);
      return 0;
    });
  }

  console.error(`unknown command: ${cmd}\nrun with one of: serve status json monitor raw on off ` +
    `heat set-heat schedules set-schedule set-chlor set-clock light set-pump`);
  return 2;
}

const code = await main();
if (code >= 0) process.exit(code);
