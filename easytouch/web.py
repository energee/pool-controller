"""
easytouch.web — the single-page human dashboard served at ``GET /``.

``PAGE`` is one self-contained HTML document (inline CSS + vanilla JS, **no
external assets**) that is a pure client of the existing, live-verified JSON API
in :mod:`easytouch.api`:

* polls ``GET /state`` every few seconds and renders a compact summary bar
  (connection, key temps, what's on) plus a card per section — controller
  status, heat, circuits, salt/chlorinator, schedules, pumps/clock, and the
  raw/undecoded frames (collapsed into a ``<details>`` at the bottom);
* writes through the same endpoints the CLI/curl use — circuit toggles hit
  ``GET /circuit/<n>/<on|off>``, heat setpoints/modes ``POST /heat``, and
  schedule slots ``POST /schedule``;
* **pauses card re-rendering while a control is focused or was just changed** so
  inputs never jump under the user mid-edit (the read-only summary bar still
  updates live).

The visual language is a dark, Linear-inspired theme: near-black layered
surfaces, hairline borders, an indigo accent, tabular numerals, and quiet
section labels. Keeping the whole UI in one stdlib-served string preserves the
project's zero-extra-dependency, no-build, no-template-engine constraint (system
fonts only — there is no external font/CSS/JS; see test_web.py).
"""
from __future__ import annotations

# A single self-contained document. Plain (non-f) string: every ``{`` / ``}`` is
# literal JS/CSS. No backslashes, no external src/href, no CDN — see test_web.py.
PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>easytouch — pool dashboard</title>
<style>
  :root {
    --bg: #08090a; --bg-elev: #0e0f11; --card: #101113; --line: rgba(255,255,255,.07);
    --line-strong: rgba(255,255,255,.13); --fg: #e6e7ea; --fg-dim: #b6bac1;
    --muted: #8a8f98; --accent: #5e6ad2; --accent-hover: #6872d8;
    --accent-soft: rgba(94,106,210,.15); --on: #4cc38a; --off: #3a3f47;
    --warn: #e2a93b; --bad: #e5534b; --good: #4cc38a;
    --radius: 8px; --radius-sm: 6px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: var(--fg);
    background:
      radial-gradient(900px 480px at 50% -220px, rgba(94,106,210,.10), transparent 70%),
      var(--bg);
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased; font-variant-numeric: tabular-nums;
  }
  header {
    position: sticky; top: 0; z-index: 10;
    display: flex; align-items: center; gap: 12px; padding: 12px 20px;
    background: rgba(8,9,10,.72); backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--line);
  }
  .mark { font-size: 15px; font-weight: 600; letter-spacing: -.01em; }
  .pill {
    display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--muted);
    background: var(--bg-elev); border: 1px solid var(--line); border-radius: 999px; padding: 4px 10px;
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--off); flex: 0 0 auto; }
  .dot.ok { background: var(--good); box-shadow: 0 0 0 3px rgba(76,195,138,.16); }
  .dot.bad { background: var(--bad); box-shadow: 0 0 0 3px rgba(229,83,75,.16); }
  .spacer { flex: 1; }
  button {
    font: inherit; font-weight: 550; cursor: pointer; color: #fff;
    background: var(--accent); border: 1px solid transparent; border-radius: var(--radius-sm);
    padding: 7px 13px; transition: background .12s ease, border-color .12s ease, color .12s ease;
  }
  button:hover { background: var(--accent-hover); }
  button.ghost { background: transparent; color: var(--fg-dim); border-color: var(--line); }
  button.ghost:hover { background: var(--bg-elev); border-color: var(--line-strong); color: var(--fg); }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 20px; }

  .summary {
    display: grid; gap: 10px; margin-bottom: 18px;
    grid-template-columns: repeat(auto-fit, minmax(124px, 1fr));
  }
  .stat { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; }
  .stat .lbl { font-size: 11px; color: var(--muted); letter-spacing: .04em; text-transform: uppercase; }
  .stat .val { font-size: 22px; font-weight: 550; margin-top: 3px; letter-spacing: -.01em; }
  .stat .val.sm { font-size: 14px; font-weight: 500; margin-top: 5px; }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
  .chip {
    font-size: 11px; color: var(--accent); background: var(--accent-soft);
    border: 1px solid rgba(94,106,210,.25); border-radius: 999px; padding: 2px 8px;
  }
  .chip.muted { color: var(--muted); background: var(--bg-elev); border-color: var(--line); }

  main { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px;
    transition: border-color .12s ease;
  }
  .card:hover { border-color: var(--line-strong); }
  .card h2 {
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em;
    color: var(--muted); margin: 0 0 12px; display: flex; align-items: center;
  }
  .card .exp {
    font-size: 10px; color: var(--warn); border: 1px solid rgba(226,169,59,.4);
    border-radius: 999px; padding: 1px 7px; margin-left: 8px; text-transform: none; letter-spacing: 0;
  }
  .row { display: flex; justify-content: space-between; gap: 10px; padding: 7px 0; border-top: 1px solid var(--line); }
  .row:first-child { border-top: 0; }
  .row .k { color: var(--muted); }
  .row .v { color: var(--fg); }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .tile { background: var(--bg-elev); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 10px 12px; }
  .tile .k { font-size: 11px; color: var(--muted); }
  .tile .big { font-size: 20px; font-weight: 550; margin-top: 2px; letter-spacing: -.01em; }
  label { display: block; font-size: 11px; color: var(--muted); margin-bottom: 5px; }
  input, select {
    width: 100%; font: inherit; color: var(--fg); background: var(--bg-elev);
    border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 8px 10px;
    transition: border-color .12s ease, box-shadow .12s ease;
  }
  input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .field { margin-bottom: 10px; }
  .circuits { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .switch {
    display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: pointer;
    background: var(--bg-elev); border: 1px solid var(--line); border-radius: var(--radius-sm);
    padding: 9px 11px; font-size: 13px; transition: border-color .12s ease;
  }
  .switch:hover { border-color: var(--line-strong); }
  .switch input { width: auto; accent-color: var(--accent); }
  details.raw-card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); grid-column: 1 / -1; }
  details.raw-card > summary {
    list-style: none; cursor: pointer; padding: 14px 16px;
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--muted);
  }
  details.raw-card > summary::-webkit-details-marker { display: none; }
  details.raw-card[open] > summary { border-bottom: 1px solid var(--line); }
  .raw-body { padding: 6px 16px 14px; }
  table.raw { width: 100%; border-collapse: collapse; font-size: 12px; }
  table.raw td { padding: 6px 8px; border-top: 1px solid var(--line); vertical-align: top; }
  table.raw td.hex { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); word-break: break-all; }
  .err { color: var(--bad); font-size: 12px; }
  .muted { color: var(--muted); }
</style>
</head>
<body>
<header>
  <span class="mark">easytouch</span>
  <span class="pill"><span id="dot" class="dot"></span><span id="conn">connecting…</span></span>
  <span class="spacer"></span>
  <button class="ghost" onclick="afterChange()">Refresh</button>
</header>
<div class="wrap">
  <section class="summary" id="summary"></section>
  <main id="cards"><div class="card"><h2>loading</h2><div class="muted">fetching state…</div></div></main>
</div>

<script>
const POLL_MS = 3000;
const CIRCUITS = [[1,'spa'],[2,'aux1'],[3,'aux2'],[4,'aux3'],[5,'aux4'],
                  [6,'pool'],[7,'feature1'],[8,'feature2'],[9,'feature3'],[10,'feature4']];
const MODES = [[0,'Off'],[1,'Heater'],[2,'Solar Pref'],[3,'Solar Only']];
const CFI_NAMES = {2:'Controller Status',5:'Date/Time',7:'Pump Status',8:'Heat Status',
  10:'Custom Names',11:'Circuit Names',17:'Schedule',18:'IntelliChem',25:'IntelliChlor',
  29:'Valve Status',252:'SW Version'};

let lastState = null;
let holdUntil = 0;
let rawOpen = false;

// Pause card re-render while the user is mid-edit: either a control is focused,
// or a change happened recently (cooldown), so inputs never jump underneath them.
function hold(ms) { holdUntil = Date.now() + (ms || 7000); }
function editing() {
  if (Date.now() < holdUntil) return true;
  const a = document.activeElement;
  return !!(a && (a.tagName === 'INPUT' || a.tagName === 'SELECT'));
}

function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function temp(t, u) { return (t == null) ? '—' : (t + '°' + (u || 'F')); }

async function getState() {
  const r = await fetch('/state', {cache: 'no-store'});
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function tick() {
  try {
    const s = await getState();
    lastState = s;
    renderBar(s);
    renderSummary(s);                 // read-only — safe to refresh even mid-edit
    if (!editing()) renderCards(s);
  } catch (e) {
    document.getElementById('dot').className = 'dot bad';
    document.getElementById('conn').textContent = 'unreachable: ' + e.message;
  } finally {
    setTimeout(tick, POLL_MS);
  }
}

function renderBar(s) {
  const live = s.connected && (s.age == null || s.age < 30);
  document.getElementById('dot').className = 'dot ' + (live ? 'ok' : 'bad');
  const age = (s.age == null) ? 'no packets yet' : (Math.round(s.age) + 's ago');
  const err = s.error ? (' · ' + s.error) : '';
  document.getElementById('conn').textContent =
    (s.connected ? 'connected' : 'disconnected') + ' · ' + age + err;
}

function renderSummary(s) {
  const el = document.getElementById('summary');
  const st = s.status;
  if (!st) { el.innerHTML = stat('Status', 'waiting…', 'sm'); return; }
  const u = st.unit || 'F';
  const names = st.circuit_names || [];
  const chips = names.length
    ? '<div class="chips">' + names.map(n => '<span class="chip">' + esc(n) + '</span>').join('') + '</div>'
    : '<div class="chips"><span class="chip muted">all off</span></div>';
  el.innerHTML =
    stat('Pool', temp(st.pool_temp, u)) +
    stat('Spa', temp(st.spa_temp, u)) +
    stat('Air', temp(st.air_temp, u)) +
    stat('Heater', st.heater_on ? 'On' : 'Off', 'sm') +
    statRaw('On now', chips);
}

function renderCards(s) {
  const cards = [];
  cards.push(statusCard(s.status));            // primary
  cards.push(heatCard(s.heat));
  cards.push(circuitsCard(s.status));
  cards.push(lightsCard());
  cards.push(chlorinatorCard(s.chlorinator));  // secondary
  cards.push(intellichemCard(s.intellichem));
  cards.push(schedulesCard(s.schedules));
  cards.push(pumpsCard(s.pumps, s.datetime));
  cards.push(valvesCard(s.valves));
  cards.push(namesCard(s.names));
  cards.push(rawCard(s.raw));                   // utility (collapsed)
  document.getElementById('cards').innerHTML = cards.join('');
}

function statusCard(st) {
  if (!st) return card('Controller', '<div class="muted">waiting for status broadcast…</div>');
  const u = st.unit || 'F';
  const flags = [st.heater_on ? 'heater on' : null, st.freeze ? 'FREEZE' : null,
                 st.service ? 'service' : null].filter(Boolean).join(' · ') || '—';
  const body =
    row('Clock', esc(st.clock)) +
    '<div class="grid2" style="margin:10px 0">' +
      tile('Pool', temp(st.pool_temp, u)) + tile('Spa', temp(st.spa_temp, u)) +
      tile('Air', temp(st.air_temp, u)) + tile('Solar', temp(st.solar_temp, u)) +
    '</div>' +
    row('On now', esc((st.circuit_names || []).join(', ') || 'none')) +
    row('Heat mode', 'pool ' + esc(st.pool_heat_mode) + ' · spa ' + esc(st.spa_heat_mode)) +
    row('Flags', esc(flags));
  return card('Controller', body);
}

function heatCard(h) {
  if (!h) return card('Heat / setpoints', '<div class="muted">waiting for heat status…</div>');
  const u = 'F';
  const poolMode = (h.heat_mode_raw || 0) & 0x03;
  const spaMode = ((h.heat_mode_raw || 0) >> 2) & 0x03;
  const modeSel = (id, cur) => '<select id="' + id + '">' +
    MODES.map(m => '<option value="' + m[0] + '"' + (m[0] === cur ? ' selected' : '') + '>' + m[1] + '</option>').join('') +
    '</select>';
  const body =
    '<div class="grid2" style="margin-bottom:12px">' +
      tile('Pool temp', temp(h.pool_temp, u)) + tile('Spa temp', temp(h.spa_temp, u)) +
    '</div>' +
    '<div class="grid2">' +
      '<div class="field"><label>Pool setpoint</label><input id="pool_sp" type="number" value="' + esc(h.pool_setpoint) + '"></div>' +
      '<div class="field"><label>Spa setpoint</label><input id="spa_sp" type="number" value="' + esc(h.spa_setpoint) + '"></div>' +
      '<div class="field"><label>Pool mode</label>' + modeSel('pool_mode', poolMode) + '</div>' +
      '<div class="field"><label>Spa mode</label>' + modeSel('spa_mode', spaMode) + '</div>' +
    '</div>' +
    '<button onclick="applyHeat()">Apply heat</button>';
  return card('Heat / setpoints', body);
}

function chlorinatorCard(c) {
  // Salt rides the IntelliChlor native protocol; status_flags are shown raw (the
  // bit meanings aren't reliably decoded), salt = on-wire byte x 50 ppm.
  if (!c) return card('Salt / Chlorinator',
    '<div class="muted">no recent salt data — the chlorinator only reports while the pool is running.</div>');
  const salt = (c.salt_ppm == null) ? '—' : (c.salt_ppm + ' ppm');
  const out = (c.output_percent == null) ? '—' : (c.output_percent + '%');
  let body =
    '<div class="grid2">' + tile('Salt', salt) + tile('Output', out) + '</div>';
  body += '<div class="field" style="margin-top:10px"><label>Set output %</label>' +
          '<input id="chlor_out" type="number" min="0" max="100" value="' +
          esc(c.output_percent == null ? 0 : c.output_percent) + '"></div>' +
          '<button onclick="setChlor()">Set output</button>';
  if (c.status_flags != null) {
    body += row('Status flags', '0x' + Number(c.status_flags).toString(16));
  }
  if (c.age != null) {
    const ago = c.age < 90 ? Math.round(c.age) + 's' : Math.round(c.age / 60) + 'm';
    body += '<div class="muted" style="margin-top:8px">' +
            (c.age > 120 ? '⚠ stale — last update ' : 'updated ') + ago + ' ago</div>';
  }
  return card('Salt / Chlorinator', body);
}

function intellichemCard(c) {
  if (!c) return '';   // only shown when an IntelliChem controller is present
  let body = '<div class="grid2">' +
    tile('pH', c.ph == null ? '—' : c.ph) +
    tile('ORP', c.orp == null ? '—' : c.orp + ' mV') + '</div>';
  body += row('pH setpoint', esc(c.ph_setpoint)) + row('ORP setpoint', esc(c.orp_setpoint) + ' mV');
  return card('IntelliChem', body, true);   // experimental: layout unconfirmed
}

function valvesCard(v) {
  if (!v) return '';   // shown only once a valve-status frame (CFI 29) has arrived
  const vals = (v.valves || []);
  const tiles = vals.length
    ? '<div class="grid2">' + vals.map((b, i) => tile('Valve ' + (i + 1), b)).join('') + '</div>'
    : '<div class="muted">no valve positions</div>';
  const body = tiles + row('Raw', '<span class="muted">' + esc(v.raw) + '</span>');
  return card('Valves', body, true);   // experimental: per-byte meanings unconfirmed
}

function namesCard(names) {
  names = names || {};
  const keys = Object.keys(names).sort((a, b) => a - b);
  if (!keys.length) return '';   // shown only once circuit-name config (CFI 11) arrives
  const rows = keys.map(k => {
    const n = names[k];
    return row('Circuit ' + esc(n.circuit), 'fn ' + esc(n.function) + ' · name id ' + esc(n.name_id));
  }).join('');
  return card('Circuit config / names',
    rows + '<div class="muted" style="margin-top:8px">name id → text needs a live capture; ' +
    'display names use the built-in defaults.</div>', true);
}

function circuitsCard(st) {
  const on = (st && st.circuits_on) || [];
  const cells = CIRCUITS.map(c => {
    const checked = on.indexOf(c[0]) >= 0 ? ' checked' : '';
    return '<label class="switch">' + esc(c[1]) +
      '<input type="checkbox"' + checked +
      ' onchange="setCircuit(' + c[0] + ', this.checked)"></label>';
  }).join('');
  return card('Circuits', '<div class="circuits">' + cells + '</div>');
}

function lightsCard() {
  // IntelliBrite commands are global to the light group; codes are the documented
  // reference mapping (unconfirmed on this hardware) -> marked experimental.
  const cmds = ['on','off','color_sync','color_swim','color_set','party','romance',
                'caribbean','american','sunset','royal','blue','green','red','white','magenta'];
  const btns = cmds.map(c =>
    '<button class="ghost" style="margin:3px" onclick="setLight(\'' + c + '\')">' +
    esc(c.replace('_',' ')) + '</button>').join('');
  return card('Lights (IntelliBrite)', '<div>' + btns + '</div>', true);
}

function pumpsCard(pumps, dt) {
  pumps = pumps || {};
  const keys = Object.keys(pumps);
  let body = '';
  if (!keys.length) {
    body = '<div class="muted">no pumps reporting</div>';
  } else {
    body = keys.map(k => {
      const p = pumps[k];
      return '<div style="margin-bottom:8px">' +
        '<div class="k muted">Pump ' + esc(p.pump || k) + '</div>' +
        row('Watts', esc(p.watts)) + row('RPM', esc(p.rpm)) + row('GPM', esc(p.gpm)) + '</div>';
    }).join('');
  }
  if (dt) body += row('Controller clock', esc(dt.iso));
  if (lastState && lastState.version) body += row('Firmware', esc(lastState.version.version));
  body += '<button class="ghost" style="margin-top:10px" onclick="setClock()">Set clock to now</button>';
  // EXPERIMENTAL: direct pump RPM (unverified; may contend with the controller).
  body += '<div class="field" style="margin-top:12px"><label>Pump # / RPM (experimental)</label>' +
          '<div class="grid2"><input id="pump_n" type="number" value="1" min="1" max="4">' +
          '<input id="pump_rpm" type="number" value="2400"></div></div>' +
          '<button class="ghost" onclick="setPump()">Set RPM (experimental)</button>';
  return card('Pumps &amp; clock', body);
}

function schedulesCard(scheds) {
  scheds = scheds || {};
  const all = Object.keys(scheds).sort((a, b) => a - b).map(id => scheds[id]);
  const active = all.filter(x => x.active);
  const empty = all.length - active.length;
  let list;
  if (!all.length) {
    list = '<div class="muted">no schedules cached yet — they load as the controller replies.</div>';
  } else if (!active.length) {
    list = '<div class="muted">no schedules programmed (' + empty + ' empty slots).</div>';
  } else {
    list = active.map(x =>
      row('#' + esc(x.id) + ' ' + esc(x.circuit_name),
          esc(x.start) + '–' + esc(x.end) + ' · ' + esc((x.days || []).join(',')))
    ).join('');
    if (empty) list += '<div class="muted" style="margin-top:8px">+ ' + empty + ' empty slots</div>';
  }
  const editor =
    '<div class="grid2" style="margin-top:12px">' +
      '<div class="field"><label>Slot id</label><input id="sch_id" type="number" value="1"></div>' +
      '<div class="field"><label>Circuit</label><input id="sch_circuit" value="pool"></div>' +
      '<div class="field"><label>Start</label><input id="sch_start" type="time" value="08:00"></div>' +
      '<div class="field"><label>End</label><input id="sch_end" type="time" value="10:30"></div>' +
    '</div>' +
    '<div class="field"><label>Days (e.g. mon,wed,fri or every)</label><input id="sch_days" value="every"></div>' +
    '<button onclick="saveSchedule()">Save schedule</button>';
  return card('Schedules', list + editor);
}

function rawCard(raw) {
  raw = raw || {};
  const keys = Object.keys(raw).sort((a, b) => a - b);
  const inner = !keys.length
    ? '<div class="muted">none captured yet</div>'
    : '<table class="raw">' + keys.map(cfi => {
        const name = CFI_NAMES[cfi] || ('CFI ' + cfi);
        return '<tr><td>' + esc(cfi) + '<br><span class="muted">' + esc(name) + '</span></td>' +
               '<td class="hex">' + esc(raw[cfi]) + '</td></tr>';
      }).join('') + '</table>';
  return '<details class="raw-card"' + (rawOpen ? ' open' : '') + ' ontoggle="rawOpen=this.open">' +
         '<summary>Raw frames · ' + keys.length + '</summary>' +
         '<div class="raw-body">' + inner + '</div></details>';
}

// --- small builders ---
function card(title, body, experimental) {
  const tag = experimental ? '<span class="exp">experimental</span>' : '';
  return '<div class="card"><h2>' + title + tag + '</h2>' + body + '</div>';
}
function row(k, v) { return '<div class="row"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>'; }
function tile(k, v) { return '<div class="tile"><div class="k">' + k + '</div><div class="big">' + v + '</div></div>'; }
function stat(lbl, val, cls) {
  return '<div class="stat"><div class="lbl">' + lbl + '</div><div class="val ' + (cls || '') + '">' + val + '</div></div>';
}
function statRaw(lbl, inner) {
  return '<div class="stat"><div class="lbl">' + lbl + '</div>' + inner + '</div>';
}

// --- controls (write through the existing endpoints) ---
async function setCircuit(num, on) {
  hold();
  try { await fetch('/circuit/' + num + '/' + (on ? 'on' : 'off')); }
  catch (e) { alert('circuit failed: ' + e.message); }
  afterChange();
}

async function setChlor() {
  hold();
  const v = Number(document.getElementById('chlor_out').value);
  await postJSON('/chlorinator', {output: v});
  afterChange();
}

async function setClock() {
  hold();
  await postJSON('/datetime', {});
  afterChange();
}

async function setLight(cmd) {
  hold();
  await postJSON('/light', {command: cmd});
  afterChange();
}

async function setPump() {
  hold();
  await postJSON('/pump', {pump: Number(document.getElementById('pump_n').value),
                          rpm: Number(document.getElementById('pump_rpm').value)});
  afterChange();
}

async function applyHeat() {
  hold();
  const body = {
    pool_setpoint: Number(document.getElementById('pool_sp').value),
    spa_setpoint: Number(document.getElementById('spa_sp').value),
    pool_mode: Number(document.getElementById('pool_mode').value),
    spa_mode: Number(document.getElementById('spa_mode').value),
  };
  await postJSON('/heat', body);
  afterChange();
}

async function saveSchedule() {
  hold();
  const body = {
    id: Number(document.getElementById('sch_id').value),
    circuit: document.getElementById('sch_circuit').value,
    start: document.getElementById('sch_start').value,
    end: document.getElementById('sch_end').value,
    days: document.getElementById('sch_days').value,
  };
  await postJSON('/schedule', body);
  afterChange();
}

async function postJSON(path, body) {
  try {
    const r = await fetch(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    if (!r.ok && r.status !== 202) alert(path + ' failed: HTTP ' + r.status);
  } catch (e) { alert(path + ' failed: ' + e.message); }
}

// Explicit refresh after a change: re-render even if a control still has focus,
// and keep the edit-hold so the background poll does not clobber the new values.
async function afterChange() {
  hold();
  try {
    const s = await getState();
    lastState = s;
    renderBar(s);
    renderSummary(s);
    renderCards(s);
  } catch (e) { /* the next poll will recover */ }
}

tick();
</script>
</body>
</html>
"""
