// Shape of the GET /state JSON snapshot the dashboard renders. The API decodes
// loosely (fields appear as frames arrive), so most fields are optional/nullable.

export interface Status {
  clock?: string;
  circuits_on?: number[];
  circuit_names?: string[];
  pool_temp?: number | null;
  spa_temp?: number | null;
  air_temp?: number | null;
  solar_temp?: number | null;
  heater_on?: boolean;
  freeze?: boolean;
  service?: boolean;
  pool_heat_mode?: string;
  spa_heat_mode?: string;
  unit?: string;
}

export interface Heat {
  pool_temp?: number | null;
  spa_temp?: number | null;
  air_temp?: number | null;
  pool_setpoint?: number;
  spa_setpoint?: number;
  heat_mode_raw?: number;
}

export interface Chlor {
  salt_ppm?: number | null;
  output_percent?: number | null;
  status_flags?: number | null;
  age?: number | null;
}

export interface Intellichem {
  ph?: number | null;
  orp?: number | null;
  ph_setpoint?: number | string;
  orp_setpoint?: number | string;
}

export interface Valves {
  valves?: (string | number)[];
  raw?: string;
}

export interface NameEntry {
  circuit: number | string;
  function: number | string;
  name_id: number | string;
}

export interface Pump {
  pump?: number | string;
  watts?: number;
  rpm?: number;
  gpm?: number;
}

export interface Schedule {
  id: number | string;
  circuit?: number; // circuit number (0 = empty slot); circuit_name is its label
  circuit_name?: string;
  start?: string;
  end?: string;
  days?: string[]; // ["Every day"] or ["Mon","Wed",...] from decode_days
  active?: boolean;
}

export interface State {
  connected?: boolean;
  error?: string | null;
  age?: number | null;
  status?: Status | null;
  heat?: Heat | null;
  chlorinator?: Chlor | null;
  intellichem?: Intellichem | null;
  valves?: Valves | null;
  names?: Record<string, NameEntry>;
  pumps?: Record<string, Pump>;
  schedules?: Record<string, Schedule>;
  datetime?: { iso?: string } | null;
  version?: { version?: string } | null;
  raw?: Record<string, string>;
}

// What the command endpoints return; the dashboard surfaces this as the verdict.
export interface Verdict {
  confirmed?: boolean;
  accepted?: boolean;
  sent?: boolean;
  [k: string]: unknown;
}
