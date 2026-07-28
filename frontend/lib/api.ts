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

// ponytail: one shared toast id — a new verdict replaces the old one instead of
// stacking a column of them when the user clicks several controls in a row.
const VERDICT = "verdict";

// Issue a command and surface the server's verdict as a toast. Success is
// deliberately silent: the control that was just touched already shows the
// round trip (pending -> settled from the next poll), so a toast in the far
// corner of the screen only restates it. Callers that want more than the
// warning/error toasts read the returned Verdict and render it in place -- see
// CircuitsCard, which marks the tile the controller never confirmed.
//   confirmed       -> silent
//   accepted (202)  -> sent, not confirmed by controller (warning)
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
    if (!r.ok)
      toast.error("Failed — HTTP " + r.status, { id: VERDICT, description: path });
    else if (r.status === 202 || body.accepted)
      toast.warning("Sent — not confirmed by controller", { id: VERDICT });
    return body;
  } catch (e) {
    toast.error("Failed — " + (e as Error).message, {
      id: VERDICT,
      description: path,
    });
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
