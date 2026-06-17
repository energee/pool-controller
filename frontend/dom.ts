// Small DOM/string helpers: HTML escaping, the card/row/tile/stat builders, the
// edit-guard (hold/editing), the transient flash banner, and an input reader.
import { store } from "./store";

export function esc(s: unknown): string {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function temp(t: number | null | undefined, u?: string): string {
  return (t == null) ? "—" : (t + "°" + (u || "F"));
}

export function card(title: string, body: string, experimental?: boolean): string {
  const tag = experimental ? '<span class="exp">experimental</span>' : "";
  return '<div class="card"><h2>' + title + tag + "</h2>" + body + "</div>";
}

export function row(k: string, v: string | number): string {
  return '<div class="row"><span class="k">' + k + '</span><span class="v">' + v + "</span></div>";
}

export function tile(k: string, v: string | number): string {
  return '<div class="tile"><div class="k">' + k + '</div><div class="big">' + v + "</div></div>";
}

export function stat(lbl: string, val: string | number, cls?: string): string {
  return '<div class="stat"><div class="lbl">' + lbl + '</div><div class="val ' + (cls || "") + '">' + val + "</div></div>";
}

export function statRaw(lbl: string, inner: string): string {
  return '<div class="stat"><div class="lbl">' + lbl + "</div>" + inner + "</div>";
}

// Pause card re-render while the user is mid-edit: a control is focused, or a
// change happened recently (cooldown), so inputs never jump underneath them.
export function hold(ms?: number): void {
  store.holdUntil = Date.now() + (ms || 7000);
}

export function editing(): boolean {
  if (Date.now() < store.holdUntil) return true;
  const a = document.activeElement;
  return !!(a && (a.tagName === "INPUT" || a.tagName === "SELECT"));
}

// Read the value of an <input>/<select> by id (controls write through endpoints).
export function val(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value;
}

let flashTimer: ReturnType<typeof setTimeout>;

// Transient status banner. Errors/warnings linger longer than successes.
export function flash(msg: string, kind: string): void {
  const el = document.getElementById("flash")!;
  el.textContent = msg;
  el.className = "flash show " + kind;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.className = "flash"; },
                          (kind === "bad" || kind === "warn") ? 6000 : 3000);
}
