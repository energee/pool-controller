// Entry point: poll /state on an interval, render, and expose the control
// handlers as globals so the inline onclick/onchange attributes in the generated
// card HTML (and the static Refresh button) can call them.
import { editing } from "./dom";
import { renderBar, renderCards, renderSummary } from "./cards";
import { store } from "./store";
import {
  afterChange, applyHeat, getState, saveSchedule,
  setChlor, setCircuit, setClock, setLight, setPump,
} from "./controls";

const POLL_MS = 3000;

async function tick(): Promise<void> {
  try {
    const s = await getState();
    store.lastState = s;
    renderBar(s);
    renderSummary(s);                 // read-only — safe to refresh even mid-edit
    if (!editing()) renderCards(s);
  } catch (e) {
    document.getElementById("dot")!.className = "dot bad";
    document.getElementById("conn")!.textContent = "unreachable: " + (e as Error).message;
  } finally {
    setTimeout(tick, POLL_MS);
  }
}

// Inline handlers in the card HTML reference these as globals.
Object.assign(window, {
  setCircuit, setChlor, setClock, setLight, setPump, applyHeat, saveSchedule, afterChange,
  setRawOpen: (v: boolean) => { store.rawOpen = v; },
});

tick();
