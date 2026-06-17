// Write paths: each control posts through the existing JSON endpoints, then calls
// afterChange() to refresh. command() surfaces the server's confirmation verdict
// (the backend waits for the controller's own state frames before answering).
import { flash, hold, val } from "./dom";
import { renderBar, renderCards, renderSummary } from "./cards";
import { store } from "./store";
import type { State, Verdict } from "./types";

export async function getState(): Promise<State> {
  const r = await fetch("/state", { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json() as Promise<State>;
}

// Issue a command and surface the server's verdict:
//   confirmed -> verified applied   accepted (202) -> sent, not confirmed
//   sent      -> best-effort (no state to verify against; e.g. light, clock)
export async function command(path: string, opts?: RequestInit): Promise<Verdict | undefined> {
  try {
    const r = await fetch(path, opts);
    let body: Verdict = {};
    try { body = await r.json(); } catch (e) { /* non-JSON / empty */ }
    if (!r.ok) flash(path + " failed: HTTP " + r.status, "bad");
    else if (body.confirmed) flash("✓ confirmed applied", "ok");
    else if (r.status === 202 || body.accepted) flash("⚠ sent — not confirmed by controller", "warn");
    else flash("sent (not verifiable)", "");
    return body;
  } catch (e) { flash(path + " failed: " + (e as Error).message, "bad"); }
}

function postJSON(path: string, body: unknown): Promise<Verdict | undefined> {
  return command(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function setCircuit(num: number, on: boolean): Promise<void> {
  hold();
  await command("/circuit/" + num + "/" + (on ? "on" : "off"));
  await afterChange();
}

export async function setChlor(): Promise<void> {
  hold();
  await postJSON("/chlorinator", { output: Number(val("chlor_out")) });
  await afterChange();
}

export async function setClock(): Promise<void> {
  hold();
  await postJSON("/datetime", {});
  await afterChange();
}

export async function setLight(cmd: string): Promise<void> {
  hold();
  await postJSON("/light", { command: cmd });
  await afterChange();
}

export async function setPump(): Promise<void> {
  hold();
  await postJSON("/pump", { pump: Number(val("pump_n")), rpm: Number(val("pump_rpm")) });
  await afterChange();
}

export async function applyHeat(): Promise<void> {
  hold();
  await postJSON("/heat", {
    pool_setpoint: Number(val("pool_sp")),
    spa_setpoint: Number(val("spa_sp")),
    pool_mode: Number(val("pool_mode")),
    spa_mode: Number(val("spa_mode")),
  });
  await afterChange();
}

export async function saveSchedule(): Promise<void> {
  hold();
  await postJSON("/schedule", {
    id: Number(val("sch_id")),
    circuit: val("sch_circuit"),
    start: val("sch_start"),
    end: val("sch_end"),
    days: val("sch_days"),
  });
  await afterChange();
}

// Explicit refresh after a change: re-render even if a control still has focus,
// and keep the edit-hold so the background poll does not clobber the new values.
export async function afterChange(): Promise<void> {
  hold();
  try {
    const s = await getState();
    store.lastState = s;
    renderBar(s);
    renderSummary(s);
    renderCards(s);
  } catch (e) { /* the next poll will recover */ }
}
