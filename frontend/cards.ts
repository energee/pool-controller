// Renders the summary bar and one card per /state section. Pure functions that
// return HTML strings; controls are wired via inline handlers (exposed on window
// in app.ts). Read-only render — no fetches happen here.
import { store } from "./store";
import { card, esc, row, stat, statRaw, temp, tile } from "./dom";
import type {
  Chlor, Heat, Intellichem, NameEntry, Pump, Schedule, State, Status, Valves,
} from "./types";

const CIRCUITS: [number, string][] = [
  [1, "spa"], [2, "aux1"], [3, "aux2"], [4, "aux3"], [5, "aux4"],
  [6, "pool"], [7, "feature1"], [8, "feature2"], [9, "feature3"], [10, "feature4"],
];
const MODES: [number, string][] = [[0, "Off"], [1, "Heater"], [2, "Solar Pref"], [3, "Solar Only"]];
const CFI_NAMES: Record<number, string> = {
  2: "Controller Status", 5: "Date/Time", 7: "Pump Status", 8: "Heat Status",
  10: "Custom Names", 11: "Circuit Names", 17: "Schedule", 18: "IntelliChem",
  25: "IntelliChlor", 29: "Valve Status", 252: "SW Version",
};

export function renderBar(s: State): void {
  const live = s.connected && (s.age == null || s.age < 30);
  document.getElementById("dot")!.className = "dot " + (live ? "ok" : "bad");
  const age = (s.age == null) ? "no packets yet" : (Math.round(s.age) + "s ago");
  const err = s.error ? (" · " + s.error) : "";
  document.getElementById("conn")!.textContent =
    (s.connected ? "connected" : "disconnected") + " · " + age + err;
}

export function renderSummary(s: State): void {
  const el = document.getElementById("summary")!;
  const st = s.status;
  if (!st) { el.innerHTML = stat("Status", "waiting…", "sm"); return; }
  const u = st.unit || "F";
  const names = st.circuit_names || [];
  const chips = names.length
    ? '<div class="chips">' + names.map((n) => '<span class="chip">' + esc(n) + "</span>").join("") + "</div>"
    : '<div class="chips"><span class="chip muted">all off</span></div>';
  el.innerHTML =
    stat("Pool", temp(st.pool_temp, u)) +
    stat("Spa", temp(st.spa_temp, u)) +
    stat("Air", temp(st.air_temp, u)) +
    stat("Heater", st.heater_on ? "On" : "Off", "sm") +
    statRaw("On now", chips);
}

export function renderCards(s: State): void {
  const cards = [
    statusCard(s.status),            // primary
    heatCard(s.heat),
    circuitsCard(s.status),
    lightsCard(),
    chlorinatorCard(s.chlorinator),  // secondary
    intellichemCard(s.intellichem),
    schedulesCard(s.schedules),
    pumpsCard(s.pumps, s.datetime),
    valvesCard(s.valves),
    namesCard(s.names),
    rawCard(s.raw),                  // utility (collapsed)
  ];
  document.getElementById("cards")!.innerHTML = cards.join("");
}

function statusCard(st?: Status | null): string {
  if (!st) return card("Controller", '<div class="muted">waiting for status broadcast…</div>');
  const u = st.unit || "F";
  const flags = [st.heater_on ? "heater on" : null, st.freeze ? "FREEZE" : null,
                 st.service ? "service" : null].filter(Boolean).join(" · ") || "—";
  const body =
    row("Clock", esc(st.clock)) +
    '<div class="grid2" style="margin:10px 0">' +
      tile("Pool", temp(st.pool_temp, u)) + tile("Spa", temp(st.spa_temp, u)) +
      tile("Air", temp(st.air_temp, u)) + tile("Solar", temp(st.solar_temp, u)) +
    "</div>" +
    row("On now", esc((st.circuit_names || []).join(", ") || "none")) +
    row("Heat mode", "pool " + esc(st.pool_heat_mode) + " · spa " + esc(st.spa_heat_mode)) +
    row("Flags", esc(flags));
  return card("Controller", body);
}

function heatCard(h?: Heat | null): string {
  if (!h) return card("Heat / setpoints", '<div class="muted">waiting for heat status…</div>');
  const u = "F";
  const poolMode = (h.heat_mode_raw || 0) & 0x03;
  const spaMode = ((h.heat_mode_raw || 0) >> 2) & 0x03;
  const modeSel = (id: string, cur: number) => '<select id="' + id + '">' +
    MODES.map((m) => '<option value="' + m[0] + '"' + (m[0] === cur ? " selected" : "") + ">" + m[1] + "</option>").join("") +
    "</select>";
  const body =
    '<div class="grid2" style="margin-bottom:12px">' +
      tile("Pool temp", temp(h.pool_temp, u)) + tile("Spa temp", temp(h.spa_temp, u)) +
    "</div>" +
    '<div class="grid2">' +
      '<div class="field"><label>Pool setpoint</label><input id="pool_sp" type="number" value="' + esc(h.pool_setpoint) + '"></div>' +
      '<div class="field"><label>Spa setpoint</label><input id="spa_sp" type="number" value="' + esc(h.spa_setpoint) + '"></div>' +
      '<div class="field"><label>Pool mode</label>' + modeSel("pool_mode", poolMode) + "</div>" +
      '<div class="field"><label>Spa mode</label>' + modeSel("spa_mode", spaMode) + "</div>" +
    "</div>" +
    '<button onclick="applyHeat()">Apply heat</button>';
  return card("Heat / setpoints", body);
}

function chlorinatorCard(c?: Chlor | null): string {
  // Salt rides the IntelliChlor native protocol; status_flags are shown raw (the
  // bit meanings aren't reliably decoded), salt = on-wire byte x 50 ppm.
  if (!c) return card("Salt / Chlorinator",
    '<div class="muted">no recent salt data — the chlorinator only reports while the pool is running.</div>');
  const salt = (c.salt_ppm == null) ? "—" : (c.salt_ppm + " ppm");
  const out = (c.output_percent == null) ? "—" : (c.output_percent + "%");
  let body = '<div class="grid2">' + tile("Salt", salt) + tile("Output", out) + "</div>";
  body += '<div class="field" style="margin-top:10px"><label>Set output %</label>' +
          '<input id="chlor_out" type="number" min="0" max="100" value="' +
          esc(c.output_percent == null ? 0 : c.output_percent) + '"></div>' +
          '<button onclick="setChlor()">Set output</button>';
  if (c.status_flags != null) {
    body += row("Status flags", "0x" + Number(c.status_flags).toString(16));
  }
  if (c.age != null) {
    const ago = c.age < 90 ? Math.round(c.age) + "s" : Math.round(c.age / 60) + "m";
    body += '<div class="muted" style="margin-top:8px">' +
            (c.age > 120 ? "⚠ stale — last update " : "updated ") + ago + " ago</div>";
  }
  return card("Salt / Chlorinator", body);
}

function intellichemCard(c?: Intellichem | null): string {
  if (!c) return "";   // only shown when an IntelliChem controller is present
  let body = '<div class="grid2">' +
    tile("pH", c.ph == null ? "—" : c.ph) +
    tile("ORP", c.orp == null ? "—" : c.orp + " mV") + "</div>";
  body += row("pH setpoint", esc(c.ph_setpoint)) + row("ORP setpoint", esc(c.orp_setpoint) + " mV");
  return card("IntelliChem", body, true);   // experimental: layout unconfirmed
}

function valvesCard(v?: Valves | null): string {
  if (!v) return "";   // shown only once a valve-status frame (CFI 29) has arrived
  const vals = v.valves || [];
  const tiles = vals.length
    ? '<div class="grid2">' + vals.map((b, i) => tile("Valve " + (i + 1), b)).join("") + "</div>"
    : '<div class="muted">no valve positions</div>';
  const body = tiles + row("Raw", '<span class="muted">' + esc(v.raw) + "</span>");
  return card("Valves", body, true);   // experimental: per-byte meanings unconfirmed
}

function namesCard(names?: Record<string, NameEntry>): string {
  names = names || {};
  const keys = Object.keys(names).sort((a, b) => Number(a) - Number(b));
  if (!keys.length) return "";   // shown only once circuit-name config (CFI 11) arrives
  const rows = keys.map((k) => {
    const n = names![k];
    return row("Circuit " + esc(n.circuit), "fn " + esc(n.function) + " · name id " + esc(n.name_id));
  }).join("");
  return card("Circuit config / names",
    rows + '<div class="muted" style="margin-top:8px">name id → text needs a live capture; ' +
    "display names use the built-in defaults.</div>", true);
}

function circuitsCard(st?: Status | null): string {
  const on = (st && st.circuits_on) || [];
  const cells = CIRCUITS.map((c) => {
    const checked = on.indexOf(c[0]) >= 0 ? " checked" : "";
    return '<label class="switch">' + esc(c[1]) +
      '<input type="checkbox"' + checked +
      ' onchange="setCircuit(' + c[0] + ', this.checked)"></label>';
  }).join("");
  return card("Circuits", '<div class="circuits">' + cells + "</div>");
}

function lightsCard(): string {
  // IntelliBrite commands are global to the light group; codes are the documented
  // reference mapping (unconfirmed on this hardware) -> marked experimental.
  const cmds = ["on", "off", "color_sync", "color_swim", "color_set", "party", "romance",
                "caribbean", "american", "sunset", "royal", "blue", "green", "red", "white", "magenta"];
  const btns = cmds.map((c) =>
    `<button class="ghost" style="margin:3px" onclick="setLight('${c}')">` +
    esc(c.replace("_", " ")) + "</button>").join("");
  return card("Lights (IntelliBrite)", "<div>" + btns + "</div>", true);
}

function pumpsCard(pumps?: Record<string, Pump>, dt?: { iso?: string } | null): string {
  pumps = pumps || {};
  const keys = Object.keys(pumps);
  let body = "";
  if (!keys.length) {
    body = '<div class="muted">no pumps reporting</div>';
  } else {
    body = keys.map((k) => {
      const p = pumps![k];
      return '<div style="margin-bottom:8px">' +
        '<div class="k muted">Pump ' + esc(p.pump || k) + "</div>" +
        row("Watts", esc(p.watts)) + row("RPM", esc(p.rpm)) + row("GPM", esc(p.gpm)) + "</div>";
    }).join("");
  }
  if (dt) body += row("Controller clock", esc(dt.iso));
  if (store.lastState && store.lastState.version) body += row("Firmware", esc(store.lastState.version.version));
  body += '<button class="ghost" style="margin-top:10px" onclick="setClock()">Set clock to now</button>';
  // EXPERIMENTAL: direct pump RPM (unverified; may contend with the controller).
  body += '<div class="field" style="margin-top:12px"><label>Pump # / RPM (experimental)</label>' +
          '<div class="grid2"><input id="pump_n" type="number" value="1" min="1" max="4">' +
          '<input id="pump_rpm" type="number" value="2400"></div></div>' +
          '<button class="ghost" onclick="setPump()">Set RPM (experimental)</button>';
  return card("Pumps &amp; clock", body);
}

function schedulesCard(scheds?: Record<string, Schedule>): string {
  scheds = scheds || {};
  const all = Object.keys(scheds).sort((a, b) => Number(a) - Number(b)).map((id) => scheds![id]);
  const active = all.filter((x) => x.active);
  const empty = all.length - active.length;
  let list: string;
  if (!all.length) {
    list = '<div class="muted">no schedules cached yet — they load as the controller replies.</div>';
  } else if (!active.length) {
    list = '<div class="muted">no schedules programmed (' + empty + " empty slots).</div>";
  } else {
    list = active.map((x) =>
      row("#" + esc(x.id) + " " + esc(x.circuit_name),
          esc(x.start) + "–" + esc(x.end) + " · " + esc((x.days || []).join(",")))
    ).join("");
    if (empty) list += '<div class="muted" style="margin-top:8px">+ ' + empty + " empty slots</div>";
  }
  const editor =
    '<div class="grid2" style="margin-top:12px">' +
      '<div class="field"><label>Slot id</label><input id="sch_id" type="number" value="1"></div>' +
      '<div class="field"><label>Circuit</label><input id="sch_circuit" value="pool"></div>' +
      '<div class="field"><label>Start</label><input id="sch_start" type="time" value="08:00"></div>' +
      '<div class="field"><label>End</label><input id="sch_end" type="time" value="10:30"></div>' +
    "</div>" +
    '<div class="field"><label>Days (e.g. mon,wed,fri or every)</label><input id="sch_days" value="every"></div>' +
    '<button onclick="saveSchedule()">Save schedule</button>';
  return card("Schedules", list + editor);
}

function rawCard(raw?: Record<string, string>): string {
  raw = raw || {};
  const keys = Object.keys(raw).sort((a, b) => Number(a) - Number(b));
  const inner = !keys.length
    ? '<div class="muted">none captured yet</div>'
    : '<table class="raw">' + keys.map((cfi) => {
        const name = CFI_NAMES[Number(cfi)] || ("CFI " + cfi);
        return "<tr><td>" + esc(cfi) + '<br><span class="muted">' + esc(name) + "</span></td>" +
               '<td class="hex">' + esc(raw![cfi]) + "</td></tr>";
      }).join("") + "</table>";
  return '<details class="raw-card"' + (store.rawOpen ? " open" : "") + ' ontoggle="setRawOpen(this.open)">' +
         "<summary>Raw frames · " + keys.length + "</summary>" +
         '<div class="raw-body">' + inner + "</div></details>";
}
