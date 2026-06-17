// Mutable UI state shared across modules:
//   lastState  — last /state snapshot (pumpsCard reads version off it)
//   holdUntil  — edit-guard deadline; pauses card re-render so inputs don't jump
//   rawOpen    — whether the collapsed raw-frames <details> is expanded
import type { State } from "./types";

export const store = {
  lastState: null as State | null,
  holdUntil: 0,
  rawOpen: false,
};
