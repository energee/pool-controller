// Schedules card. Active schedules read as sentences ("pool · 8:00 AM–5:00 PM ·
// Every day"); tapping one opens the editor on it, "+ Add schedule" opens it on
// the lowest free slot. The editor rides a native popover (HTML popover API):
// top layer, centered, light-dismiss + Esc for free, and its open state lives
// in the DOM so the 3s re-render never touches it. Controller slot ids stay
// internal — nobody thinks in slots (they remain visible under Diagnostics →
// Raw). The editor POSTs /schedule {id, circuit, start, end, days}; circuit is
// a dropdown, times are native pickers, days are toggle chips. Editor state is
// local so the 3s poll (which only refreshes the row list) never clobbers an
// in-progress edit.
import * as React from "react";

import { postJSON } from "../../lib/api";
import { CIRCUITS, CIRCUIT_NUMBERS, DAYS } from "../../lib/constants";
import { daysToSet, setToDays } from "../../lib/days";
import { time12 } from "../../lib/format";
import { cn } from "../../lib/utils";
import type { Schedule } from "../../types";
import { DashCard, Grid2, Muted } from "../primitives";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

const SCHED_SLOTS = 12; // the controller exposes schedule slots 1..12
const POOL = String(CIRCUIT_NUMBERS.pool); // default editor circuit

const circuitName = (num: number) =>
  CIRCUITS.find(([n]) => n === num)?.[1] ?? "circuit " + num;

export function SchedulesCard({
  schedules,
  refresh,
}: {
  schedules?: Record<string, Schedule>;
  refresh: () => Promise<void>;
}) {
  const map = schedules || {};
  const all = Object.keys(map)
    .sort((a, b) => Number(a) - Number(b))
    .map((id) => map[id]);
  const active = all.filter((x) => x.active);

  // null = editor closed; a slot id = editing/creating that slot. The popover
  // element itself opens/closes via popoverTarget; editId tracks it through
  // onToggle so the row highlight clears on light-dismiss too.
  const [editId, setEditId] = React.useState<string | null>(null);
  // The popover element — also the portal container for the circuit dropdown
  // (a body-level Radix portal would paint under the top layer).
  const [pop, setPop] = React.useState<HTMLDivElement | null>(null);
  const [circuit, setCircuit] = React.useState(POOL);
  const [start, setStart] = React.useState("08:00");
  const [end, setEnd] = React.useState("17:00");
  const [daySet, setDaySet] = React.useState<Set<string>>(
    () => new Set(DAYS.map(([t]) => t)),
  );

  // Load an existing slot into the editor.
  const load = (x: Schedule) => {
    setEditId(String(x.id));
    setCircuit(x.circuit != null ? String(x.circuit) : POOL);
    setStart(x.start || "08:00");
    setEnd(x.end || "17:00");
    setDaySet(daysToSet(x.days));
  };

  // Target the lowest slot that isn't an active schedule, with fresh defaults.
  const newSlot = () => {
    let free = 1;
    while (free < SCHED_SLOTS && map[String(free)]?.active) free++;
    setEditId(String(free));
    setCircuit(POOL);
    setStart("08:00");
    setEnd("17:00");
    setDaySet(new Set(DAYS.map(([t]) => t)));
  };

  const toggleDay = (tok: string) =>
    setDaySet((prev) => {
      const next = new Set(prev);
      next.has(tok) ? next.delete(tok) : next.add(tok);
      return next;
    });

  const save = async () => {
    await postJSON("/schedule", {
      id: Number(editId),
      circuit: Number(circuit),
      start,
      end,
      days: setToDays(daySet),
    });
    await refresh();
    pop?.hidePopover(); // onToggle clears editId; on error the editor stays open
  };

  const editing = editId != null && map[editId]?.active;
  const haveFreeSlot = active.length < SCHED_SLOTS;

  let list: React.ReactNode;
  if (!all.length) {
    list = (
      <Muted>no schedules cached yet — they load as the controller replies.</Muted>
    );
  } else if (!active.length) {
    list = <Muted>no schedules programmed.</Muted>;
  } else {
    list = (
      <div className="space-y-1">
        {active.map((x) => (
          <button
            key={x.id}
            popoverTarget="sched-editor"
            onClick={() => load(x)}
            className={cn(
              "flex w-full items-center justify-between gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-accent",
              String(x.id) === editId ? "bg-accent" : "bg-popover",
            )}
          >
            <span className="font-medium">
              {x.circuit_name || circuitName(x.circuit ?? 0)}
            </span>
            <span className="text-right">
              {time12(x.start) + " – " + time12(x.end)}
              <span className="ml-1.5 text-muted-foreground">
                {(x.days || []).join(", ")}
              </span>
            </span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <DashCard title="Schedules">
      {list}

      <Button
        variant="outline"
        size="sm"
        className="mt-2 w-full"
        disabled={!haveFreeSlot}
        popoverTarget="sched-editor"
        onClick={newSlot}
      >
        {haveFreeSlot ? "+ Add schedule" : "all 12 schedules in use"}
      </Button>

      <div
        ref={setPop}
        id="sched-editor"
        popover="auto"
        onToggle={(e) => e.newState === "closed" && setEditId(null)}
        className="m-auto w-[340px] max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover p-4 text-foreground shadow-xl backdrop:bg-black/50"
      >
        <div className="flex items-center justify-between">
          <Label>{editing ? "Edit schedule" : "New schedule"}</Label>
          <Button
            variant="ghost"
            size="sm"
            popoverTarget="sched-editor"
            popoverTargetAction="hide"
          >
            Cancel
          </Button>
        </div>

        <Grid2 className="mt-2">
            {/* Full-width row; Start/End pair up on the next one. */}
            <div className="space-y-1.5 col-span-2">
              <Label>Circuit</Label>
              <Select value={circuit} onValueChange={setCircuit}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent container={pop}>
                  {CIRCUITS.map(([num, name]) => (
                    <SelectItem key={num} value={String(num)}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sch_start">Start</Label>
              <Input
                id="sch_start"
                type="time"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sch_end">End</Label>
              <Input
                id="sch_end"
                type="time"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </div>
          </Grid2>

          <div className="mt-2.5 space-y-1.5">
            <Label>Days</Label>
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map(([tok, lbl]) => (
                <Button
                  key={tok}
                  variant={daySet.has(tok) ? "default" : "outline"}
                  size="sm"
                  className="w-9 px-0"
                  onClick={() => toggleDay(tok)}
                >
                  {lbl}
                </Button>
              ))}
              <Button
                variant={daySet.size === DAYS.length ? "default" : "outline"}
                size="sm"
                onClick={() => setDaySet(new Set(DAYS.map(([t]) => t)))}
              >
                Every
              </Button>
            </div>
          </div>

          <Button className="mt-2.5" disabled={daySet.size === 0} onClick={save}>
            Save schedule
          </Button>
      </div>
    </DashCard>
  );
}
