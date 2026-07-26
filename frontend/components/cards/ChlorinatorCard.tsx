// Salt / Chlorinator card. Salt rides the IntelliChlor native protocol; the ppm
// readout is banded against Pentair's IntelliChlor operating range (saltBand in
// lib/constants) so the number carries a verdict, not just digits. Output % uses
// the same Nest-style −/+ stepper as Heat: taps settle for SETTLE_MS then
// auto-send to POST /chlorinator — no Apply button. status_flags are not shown
// (bit meanings unverified — see server/intellichlor.ts; still in the API); an
// age line flags staleness (the cell only reports while the pool is running).
import * as React from "react";

import { postJSON } from "../../lib/api";
import { SETTLE_MS, saltBand } from "../../lib/constants";
import type { Chlor } from "../../types";
import { cn } from "../../lib/utils";
import { DashCard, Muted, STAT_LABEL, Stepper } from "../primitives";

const STEP = 5; // output % per stepper tap

// Band word -> theme color: red only for the cell-cutoff band.
const BAND_CLASS: Record<ReturnType<typeof saltBand>, string> = {
  "very low": "text-destructive",
  low: "text-warning",
  OK: "text-success",
  high: "text-warning",
};

export function ChlorinatorCard({
  chlor,
  refresh,
}: {
  chlor?: Chlor | null;
  refresh: () => Promise<void>;
}) {
  if (!chlor) {
    return (
      <DashCard title="Salt / Chlorinator">
        <Muted>
          no recent salt data — the chlorinator only reports while the pool is
          running.
        </Muted>
      </DashCard>
    );
  }
  return <ChlorForm chlor={chlor} refresh={refresh} />;
}

function ChlorForm({
  chlor,
  refresh,
}: {
  chlor: Chlor;
  refresh: () => Promise<void>;
}) {
  const [out, setOut] = React.useState(chlor.output_percent ?? 0);
  const [dirty, setDirty] = React.useState(false);
  const [sending, setSending] = React.useState(false);

  // Re-seed from the controller whenever we're not mid-adjustment, so the 3s
  // poll never clobbers an in-flight change.
  React.useEffect(() => {
    if (!dirty && !sending) setOut(chlor.output_percent ?? 0);
  }, [chlor.output_percent, dirty, sending]);

  const send = React.useCallback(
    async (output: number) => {
      setSending(true);
      setDirty(false); // before the await, so a tap mid-send re-dirties and re-arms
      try {
        await postJSON("/chlorinator", { output });
        await refresh();
      } finally {
        setSending(false);
      }
    },
    [refresh]
  );

  // Debounced auto-send, the same idiom as HeatCard: every tap re-runs this
  // effect (out changed), re-arming the timer, so it fires SETTLE_MS after the
  // last tap and unmount cleanup comes for free.
  React.useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => void send(out), SETTLE_MS);
    return () => clearTimeout(t);
  }, [dirty, out, send]);

  const nudge = (dir: 1 | -1) => {
    setOut((v) => Math.min(100, Math.max(0, v + dir * STEP)));
    setDirty(true);
  };

  const band = chlor.salt_ppm != null ? saltBand(chlor.salt_ppm) : null;
  const pending = dirty || sending;

  let ageLine: React.ReactNode = null;
  if (chlor.age != null) {
    const ago =
      chlor.age < 90
        ? Math.round(chlor.age) + "s"
        : Math.round(chlor.age / 60) + "m";
    ageLine = (
      <Muted className="mt-2">
        {(chlor.age > 120 ? "⚠ stale — last update " : "updated ") + ago + " ago"}
      </Muted>
    );
  }

  return (
    <DashCard title="Salt / Chlorinator">
      <div>
        <div className={STAT_LABEL}>Salt</div>
        <div className="text-[22px] font-medium tracking-tight">
          {chlor.salt_ppm?.toLocaleString() ?? "—"}
          <span className="text-muted-foreground text-sm font-normal"> ppm</span>
          {band ? (
            <span className={cn("ml-2 text-sm font-normal", BAND_CLASS[band])}>
              {band}
            </span>
          ) : null}
        </div>
        <Muted className="text-xs">ideal 3,300–3,600 ppm</Muted>
      </div>
      <div className="mt-3">
        <Stepper
          label="Output"
          aria="Chlorinator output"
          value={
            <span className={cn(pending && "text-destructive animate-pulse")}>
              {out}%
            </span>
          }
          onNudge={nudge}
        />
      </div>
      {ageLine}
    </DashCard>
  );
}
