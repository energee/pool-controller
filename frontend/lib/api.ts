// Write/read paths to the easytouch HTTP JSON API plus the command-verdict
// surfacing. Ported from the former controls.ts: command() issues the fetch and
// reports the server's controller-confirmation verdict via a sonner toast.
import { toast } from "sonner";

import type { State, Verdict } from "../types";

// GET /state — the full cached snapshot the dashboard renders.
export async function getState(): Promise<State> {
  const r = await fetch("/state", { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return (await r.json()) as State;
}

// Issue a command and surface the server's verdict as a toast:
//   confirmed       -> verified applied (success)
//   accepted (202)  -> sent, not confirmed by controller (warning)
//   sent            -> best-effort, nothing to verify against (plain)
//   !ok / throw     -> error
export async function command(
  path: string,
  opts?: RequestInit
): Promise<Verdict | undefined> {
  try {
    const r = await fetch(path, opts);
    let body: Verdict = {};
    try {
      body = (await r.json()) as Verdict;
    } catch {
      /* non-JSON / empty */
    }
    if (!r.ok) toast.error(path + " failed: HTTP " + r.status);
    else if (body.confirmed) toast.success("✓ confirmed applied");
    else if (r.status === 202 || body.accepted)
      toast.warning("⚠ sent — not confirmed by controller");
    else toast("sent (not verifiable)");
    return body;
  } catch (e) {
    toast.error(path + " failed: " + (e as Error).message);
  }
}

// POST helper: JSON body with the right content type.
export function postJSON(
  path: string,
  body: unknown
): Promise<Verdict | undefined> {
  return command(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
