// Dev proxy: serves the LOCAL frontend build against a LIVE controller's data.
//
// `/` and `/static/*` are read from easytouch/static, so `bun run build` shows up
// on reload. Every other path (/state, POST /circuit, /heat, /schedule, ...) is
// forwarded verbatim to a running easytouch server. That server owns the RS-485
// adapter, so there is nothing to export with socat and no mock bus to run — and
// because the browser only ever talks to this origin, no CORS is involved
// (frontend/lib/api.ts uses same-origin relative fetches).
//
//   bun tools/dev-proxy.ts                                  # -> http://pool.local
//   bun tools/dev-proxy.ts --upstream http://192.168.4.34 --port 8091
//   bun tools/dev-proxy.ts --check                          # self-test, no listen
//
// WARNING: the upstream is the real controller. Commands issued from the
// dashboard actually switch the pool.

import { resolve } from "node:path";

const STATIC_DIR = resolve(import.meta.dir, "..", "easytouch", "static");

/**
 * Map a request path to a file under easytouch/static, or null to proxy it.
 * Returns null for traversal attempts so `..` can never escape STATIC_DIR.
 */
export function localAsset(pathname: string): string | null {
  const name =
    pathname === "/"
      ? "index.html"
      : pathname.startsWith("/static/")
        ? pathname.slice("/static/".length)
        : null;
  if (name === null || name === "" || name.includes("..") || name.includes("/")) return null;
  return name;
}

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

if (process.argv.includes("--check")) {
  const eq = (got: unknown, want: unknown, label: string) => {
    if (got !== want) throw new Error(`${label}: got ${got}, want ${want}`);
  };
  eq(localAsset("/"), "index.html", "root serves the dashboard");
  eq(localAsset("/static/app.js"), "app.js", "bundle comes from the local build");
  eq(localAsset("/state"), null, "state proxies upstream");
  eq(localAsset("/circuit/pool"), null, "commands proxy upstream");
  eq(localAsset("/static/../../etc/passwd"), null, "traversal refused");
  console.log("dev-proxy: checks pass");
  process.exit(0);
}

const upstream = flag("upstream", process.env.EASYTOUCH_UPSTREAM ?? "http://pool.local");
const port = Number(flag("port", "8091"));

Bun.serve({
  port,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const name = localAsset(url.pathname);
    if (name !== null) {
      const file = Bun.file(resolve(STATIC_DIR, name));
      if (await file.exists()) return new Response(file);
    }
    // ponytail: buffers the body instead of streaming it. Commands are a few
    // dozen bytes; switch to a streamed body only if something large shows up.
    const headers = new Headers(req.headers);
    headers.delete("host"); // let fetch address the upstream, not this listener
    return fetch(upstream + url.pathname + url.search, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
    });
  },
});

console.log(`dev proxy http://localhost:${port} -> local static + ${upstream} (live pool)`);
