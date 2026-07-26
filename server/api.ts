// A dependency-free HTTP JSON API over the EasyTouch bus. Ported from
// easytouch/api.py.
//
// A `BusMonitor` owns the single bus connection on its poll loop; the HTTP
// handlers only read its cached state and enqueue commands, so concurrent
// requests never contend for the half-duplex bus. Control endpoints enqueue a
// command, then poll the cache (`waitFor`) for confirmation: they return 200 with
// the new state when confirmed, or 202 accepted when the controller hasn't echoed
// the change within `confirmTimeout`.
//
// Routes (LAN, no auth):
//
//   GET  /                              the human dashboard (HTML)
//   GET  /api                           endpoint index (JSON)
//   GET  /state                         full cached snapshot
//   GET  /{status,heat,datetime,pumps,schedules,chlorinator,
//          version,valves,intellichem,names,raw}   decoded subsets
//   GET  /circuit/<name|num>/<on|off>   set a circuit (convenience)
//   GET  /heat/{pool,spa}/<temp>        set a setpoint (convenience)
//   GET  /chlorinator/output/<pct>      set salt output % (convenience)
//   GET  /light/<command>               IntelliBrite light command (convenience)
//   POST /circuit      {circuit, on}
//   POST /heat         {pool_setpoint, spa_setpoint, pool_mode, spa_mode}
//   POST /schedule     {id, circuit, start, end, days}
//   POST /chlorinator  {output}
//   POST /datetime     {iso?}  (default: now)
//   POST /light        {command}
//   POST /pump         {pump, rpm}  (EXPERIMENTAL, unverified)
//
// node:http is used rather than Bun.serve so this one file runs on both runtimes
// — the Pi runs the bundled build on plain node.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCircuit } from "./bus.js";
import { BusMonitor, type StateSnapshot, confirmed } from "./monitor.js";

export const CONFIRM_TIMEOUT_MS = 6000;

// The dashboard is TypeScript under ../frontend, bundled by Bun (`bun run build`)
// into ../easytouch/static (app.js + copied index.html/style.css). The committed
// bundle is what we serve — no build step needed at runtime.
const STATIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "easytouch", "static");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** Bad input from the client — surfaces as HTTP 400. */
class BadRequest extends Error {}
/** Not ready yet (e.g. set-heat before heat is cached) — surfaces as HTTP 503. */
class NotReady extends Error {}

// Static assets cached by mtime: app.js is ~600KB and would otherwise be re-read
// from the SD card on every dashboard load. Keyed on mtime (one cheap stat per
// request) so a rebuilt bundle is picked up without restarting the server.
const staticCache = new Map<string, { mtimeMs: number; body: Buffer }>();

/**
 * Read a built asset under `static/`. Throws for a missing file or any path that
 * escapes the directory (defence-in-depth against traversal — callers also
 * allowlist).
 */
export function readStatic(name: string): [Buffer, string, string] {
  const path = resolve(join(STATIC_DIR, name));
  const stat = statSync(path, { throwIfNoEntry: false });
  if (dirname(path) !== STATIC_DIR || !stat?.isFile()) {
    throw new Error(`not found: ${name}`);
  }
  let entry = staticCache.get(path);
  if (entry?.mtimeMs !== stat.mtimeMs) {
    entry = { mtimeMs: stat.mtimeMs, body: readFileSync(path) };
    staticCache.set(path, entry);
  }
  const etag = `W/"${entry.mtimeMs}-${entry.body.length}"`;
  return [entry.body, CONTENT_TYPES[extname(path)] ?? "application/octet-stream", etag];
}

// Subsets of getState() exposed as their own GET endpoints.
const SUBSETS = [
  "status", "heat", "datetime", "pumps", "schedules", "chlorinator",
  "version", "valves", "intellichem", "names", "raw",
] as const;

export const ENDPOINTS: Record<string, string> = {
  "GET /": "the dashboard (HTML)",
  "GET /api": "this endpoint index (JSON)",
  "GET /state": "full cached snapshot",
  "GET /{status,heat,datetime,pumps,schedules,chlorinator,version,valves,intellichem,names,raw}":
    "decoded subsets",
  "GET /circuit/<name-or-num>/<on|off>": "set a circuit",
  "GET /heat/pool/<temp>": "set pool setpoint",
  "GET /heat/spa/<temp>": "set spa setpoint",
  "GET /chlorinator/output/<pct>": "set chlorinator output %",
  "GET /light/<command>": "IntelliBrite light command (party, blue, on, off, ...)",
  "POST /circuit": "{circuit, on}",
  "POST /heat": "{pool_setpoint, spa_setpoint, pool_mode, spa_mode}",
  "POST /schedule": "{id, circuit, start, end, days}",
  "POST /chlorinator": "{output}",
  "POST /datetime": "{iso?} set clock (default now)",
  "POST /light": "{command}",
  "POST /pump": "{pump, rpm} (EXPERIMENTAL, unverified)",
};

/** One request's reply: a status code plus a JSON body or a raw asset. Assets
 *  carry an ETag so a reload revalidates with a 304 instead of re-shipping the
 *  ~600KB bundle over the Pi's WiFi. */
type Reply =
  | { code: number; json: unknown }
  | { code: number; body: Buffer; contentType: string; etag?: string };

const json = (code: number, obj: unknown): Reply => ({ code, json: obj });

function intArg(value: unknown, what: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new BadRequest(`${what}, got ${JSON.stringify(value)}`);
  return n;
}

/** An unbound HTTP server over `monitor` — the caller `listen()`s it. */
export function makeServer(monitor: BusMonitor, confirmTimeout: number = CONFIRM_TIMEOUT_MS): Server {
  const api = new PoolApi(monitor, confirmTimeout);
  return createServer((req, res) => void handle(api, req, res));
}

async function handle(api: PoolApi, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let reply: Reply;
  try {
    const parts = (req.url ?? "/").split("?")[0]!.split("/").filter(Boolean);
    reply =
      req.method === "POST"
        ? await api.routePost(parts, await readJson(req))
        : await api.routeGet(parts);
  } catch (exc) {
    const message = String((exc as Error).message ?? exc);
    const code = exc instanceof BadRequest ? 400 : exc instanceof NotReady ? 503 : 500;
    reply = json(code, { error: message });
  }
  if ("json" in reply) {
    const body = Buffer.from(JSON.stringify(reply.json, null, 2) + "\n");
    res.writeHead(reply.code, {
      "Content-Type": "application/json",
      "Content-Length": String(body.length),
    });
    res.end(body);
  } else if (reply.etag && req.headers["if-none-match"] === reply.etag) {
    res.writeHead(304, { ETag: reply.etag });
    res.end();
  } else {
    res.writeHead(reply.code, {
      "Content-Type": reply.contentType,
      "Content-Length": String(reply.body.length),
      ...(reply.etag ? { ETag: reply.etag } : {}),
    });
    res.end(reply.body);
  }
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString().trim();
      if (!raw) return resolveBody({});
      try {
        resolveBody(JSON.parse(raw) as Record<string, unknown>);
      } catch (exc) {
        reject(new BadRequest(`invalid JSON body: ${(exc as Error).message}`));
      }
    });
  });
}

/** The routing + control logic, independent of node:http so tests can call it. */
export class PoolApi {
  constructor(
    readonly monitor: BusMonitor,
    readonly confirmTimeout: number = CONFIRM_TIMEOUT_MS
  ) {}

  // --- GET ---------------------------------------------------------------
  async routeGet(parts: string[]): Promise<Reply> {
    if (!parts.length) {
      const [body, contentType, etag] = readStatic("index.html"); // the human dashboard
      return { code: 200, body, contentType, etag };
    }
    const head = parts[0]!;
    if (head === "static" && parts.length === 2) {
      try {
        const [body, contentType, etag] = readStatic(parts[1]!); // built JS/CSS bundle
        return { code: 200, body, contentType, etag };
      } catch {
        return json(404, { error: "not found" });
      }
    }
    if (head === "api" && parts.length === 1) return json(200, { endpoints: ENDPOINTS });
    if (head === "state" && parts.length === 1) return json(200, this.monitor.getState());
    if ((SUBSETS as readonly string[]).includes(head) && parts.length === 1) {
      return json(200, this.monitor.getState()[head as keyof StateSnapshot]);
    }
    if (head === "circuit" && parts.length === 3) return this.circuit(parts[1]!, parts[2]!);
    if (head === "heat" && parts.length === 3 && (parts[1] === "pool" || parts[1] === "spa")) {
      const temp = intArg(parts[2], "temperature must be an integer");
      return this.setHeat({ [`${parts[1]}_setpoint`]: temp });
    }
    if (head === "chlorinator" && parts.length === 3 && parts[1] === "output") {
      return this.setChlor(intArg(parts[2], "output must be an integer 0-100"));
    }
    if (head === "light" && parts.length === 2) return this.setLight(parts[1]!);
    return json(404, { error: `no such path: /${parts.join("/")}` });
  }

  // --- POST --------------------------------------------------------------
  async routePost(parts: string[], body: Record<string, unknown>): Promise<Reply> {
    const path = parts.join("/");
    if (path === "circuit") {
      if (!("circuit" in body)) throw new BadRequest("body must include 'circuit'");
      return this.circuit(String(body.circuit), body.on ? "on" : "off");
    }
    if (path === "heat") {
      const kwargs: Record<string, number> = {};
      for (const key of ["pool_setpoint", "spa_setpoint", "pool_mode", "spa_mode"]) {
        if (body[key] != null) kwargs[key] = intArg(body[key], `${key} must be an integer`);
      }
      if (!Object.keys(kwargs).length)
        throw new BadRequest("body must include at least one heat field");
      return this.setHeat(kwargs);
    }
    if (path === "schedule") {
      for (const key of ["id", "circuit", "start", "end"]) {
        if (!(key in body)) throw new BadRequest(`body must include '${key}'`);
      }
      return this.setSchedule(body);
    }
    if (path === "chlorinator") {
      const value = body.output ?? body.percent;
      if (value == null) throw new BadRequest("body must include 'output' (0-100)");
      return this.setChlor(intArg(value, "output must be an integer 0-100"));
    }
    if (path === "datetime") return this.setDatetime(body);
    if (path === "light") return this.setLight(body.command as string | number | undefined);
    if (path === "pump") return this.setPump(body);
    return json(404, { error: `no such path: /${path}` });
  }

  // --- control helpers ---------------------------------------------------
  private async circuit(nameOrNum: string, action: string): Promise<Reply> {
    let circuit: number;
    try {
      circuit = resolveCircuit(nameOrNum);
    } catch (exc) {
      throw new BadRequest(String((exc as Error).message));
    }
    const flag = { on: true, "1": true, off: false, "0": false }[action.toLowerCase()];
    if (flag === undefined) throw new BadRequest("circuit action must be on/off");
    this.monitor.setCircuit(circuit, flag);
    const st = await this.monitor.waitFor(confirmed.circuit(circuit, flag), this.confirmTimeout);
    if (st === null) return json(202, { accepted: true, circuit, on: flag });
    return json(200, { confirmed: true, circuit, on: flag, status: st.status });
  }

  private async setHeat(kwargs: Record<string, number>): Promise<Reply> {
    let res: Record<string, number>;
    try {
      res = this.monitor.setHeat(
        kwargs.pool_setpoint, kwargs.spa_setpoint, kwargs.pool_mode, kwargs.spa_mode
      );
    } catch (exc) {
      throw new NotReady(String((exc as Error).message));
    }
    const st = await this.monitor.waitFor(confirmed.heat(res), this.confirmTimeout);
    if (st === null) return json(202, { accepted: true, requested: res });
    return json(200, { confirmed: true, heat: st.heat });
  }

  private async setSchedule(body: Record<string, unknown>): Promise<Reply> {
    const sid = intArg(body.id, "schedule id must be an integer");
    let circuit: number;
    try {
      circuit = resolveCircuit(String(body.circuit));
    } catch (exc) {
      throw new BadRequest(String((exc as Error).message));
    }
    try {
      this.monitor.setSchedule(
        sid, circuit, String(body.start), String(body.end),
        (body.days as string | string[] | number) ?? "every"
      );
    } catch (exc) {
      throw new BadRequest(String((exc as Error).message)); // bad HH:MM or day token
    }
    const st = await this.monitor.waitFor(confirmed.schedule(sid), this.confirmTimeout);
    if (st === null) return json(202, { accepted: true, id: sid });
    return json(200, { confirmed: true, schedule: st.schedules[sid] });
  }

  private setChlor(value: number): Reply {
    // The cell's status frame carries salt but not output, so there is nothing to
    // confirm against — report what was sent (best-effort; see HANDOFF).
    return json(200, { sent: true, output_percent: this.monitor.setChlorinatorOutput(value) });
  }

  private async setDatetime(body: Record<string, unknown>): Promise<Reply> {
    let when: Date | null = null;
    if (body.iso) {
      when = new Date(String(body.iso));
      if (Number.isNaN(when.getTime())) throw new BadRequest(`invalid iso datetime: ${body.iso}`);
    }
    const res = this.monitor.setDatetime(when);
    // Confirm like the other writes: poll the cache for a Date/Time broadcast
    // echoing the date+hour we sent.
    const st = await this.monitor.waitFor(confirmed.datetime(res), this.confirmTimeout);
    if (st === null) return json(202, { accepted: true, requested: res });
    return json(200, { confirmed: true, datetime: st.datetime });
  }

  private setLight(command: string | number | undefined): Reply {
    if (command == null) throw new BadRequest("body must include 'command'");
    let code: number;
    try {
      code = this.monitor.setLight(command);
    } catch (exc) {
      throw new BadRequest(String((exc as Error).message)); // unknown light name
    }
    return json(200, { sent: true, command, code });
  }

  private setPump(body: Record<string, unknown>): Reply {
    if (body.pump == null || body.rpm == null)
      throw new BadRequest("body must include 'pump' and 'rpm'");
    const res = this.monitor.setPumpSpeed(
      intArg(body.pump, "pump must be an integer"),
      intArg(body.rpm, "rpm must be an integer")
    );
    return json(200, { sent: true, ...res }); // res carries experimental: true
  }
}

/**
 * Start the BusMonitor and serve the HTTP API until interrupted.
 * `port` is the serial/network bus (e.g. socket://192.168.4.70:4000);
 * `httpHost`/`httpPort` bind the HTTP listener.
 */
export function serve(opts: {
  port: string;
  baud?: number;
  address?: number;
  httpHost?: string;
  httpPort?: number;
  refreshInterval?: number;
}): { server: Server; monitor: BusMonitor } {
  const httpHost = opts.httpHost ?? "0.0.0.0";
  const httpPort = opts.httpPort ?? 8080;
  const monitor = new BusMonitor(
    opts.port, opts.baud, opts.address, opts.refreshInterval ?? 15_000
  ).start();
  const server = makeServer(monitor);
  server.listen(httpPort, httpHost, () => {
    console.log(`easytouch API on http://${httpHost}:${httpPort}  (bus: ${opts.port})`);
  });
  const shutdown = () => {
    server.close();
    monitor.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return { server, monitor };
}
