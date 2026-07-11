// Schedules card. Lists active schedules and a single shared slot editor that
// POSTs /schedule {id, circuit, start, end, days}. Clicking an active row loads
// it into the editor (existing schedules are editable); "New" targets the lowest
// empty slot. Circuit is a dropdown and days are toggle chips — nothing is
// free-typed except the times. Editor state is local so the 3s poll (which only
// refreshes the row list) never clobbers an in-progress edit.
import * as React from "react";

import { postJSON } from "../../lib/api";
import { CIRCUITS, DAYS } from "../../lib/constants";
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
  const empty = SCHED_SLOTS - active.length;

  const [editId, setEditId] = React.useState("1");
  const [circuit, setCircuit] = React.useState("6"); // default: pool
  const [start, setStart] = React.useState("08:00");
  const [end, setEnd] = React.useState("17:00");
  const [daySet, setDaySet] = React.useState<Set<string>>(
    () => new Set(DAYS.map(([t]) => t)),
  );

  // Load an existing slot into the editor.
  const load = (x: Schedule) => {
    setEditId(String(x.id));
    setCircuit(String(x.circuit ?? 6));
    setStart(x.start || "08:00");
    setEnd(x.end || "17:00");
    setDaySet(daysToSet(x.days));
  };

  // Target the lowest slot that isn't an active schedule, with fresh defaults.
  const newSlot = () => {
    let free = 1;
    while (free < SCHED_SLOTS && map[String(free)]?.active) free++;
    setEditId(String(free));
    setCircuit("6");
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
  };

  const editing = map[editId]?.active;

  let list: React.ReactNode;
  if (!all.length) {
    list = (
      <Muted>no schedules cached yet — they load as the controller replies.</Muted>
    );
  } else if (!active.length) {
    list = <Muted>no schedules programmed ({empty} empty slots).</Muted>;
  } else {
    list = (
      <div className="space-y-1">
        {active.map((x) => (
          <button
            key={x.id}
            onClick={() => load(x)}
            className={cn(
              "flex w-full items-center justify-between gap-2.5 rounded-md border px-2.5 py-1.5 text-left text-[13px] transition-colors hover:border-input",
              String(x.id) === editId
                ? "border-input bg-popover"
                : "border-border bg-popover/40",
            )}
          >
            <span className="text-muted-foreground">
              #{x.id} {x.circuit_name || circuitName(x.circuit ?? 0)}
            </span>
            <span className="text-right">
              {time12(x.start) + "–" + time12(x.end)}
              <span className="ml-1.5 text-muted-foreground">
                {(x.days || []).join(",")}
              </span>
            </span>
          </button>
        ))}
        {empty ? <Muted className="pt-1">+ {empty} empty slots</Muted> : null}
      </div>
    );
  }

  return (
    <DashCard title="Schedules">
      {list}

      <div className="mt-3 flex items-center justify-between">
        <Label>{editing ? "Editing #" + editId : "New slot #" + editId}</Label>
        <Button variant="outline" size="sm" onClick={newSlot}>
          New
        </Button>
      </div>

      <Grid2 className="mt-2">
        <div className="space-y-1.5">
          <Label>Circuit</Label>
          <Select value={circuit} onValueChange={setCircuit}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CIRCUITS.map(([num, name]) => (
                <SelectItem key={num} value={String(num)}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Slot</Label>
          <Select value={editId} onValueChange={setEditId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: SCHED_SLOTS }, (_, i) => i + 1).map((i) => {
                const s = map[String(i)];
                return (
                  <SelectItem key={i} value={String(i)}>
                    {i} · {s?.active ? s.circuit_name || circuitName(s.circuit ?? 0) : "empty"}
                  </SelectItem>
                );
              })}
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

      <Button
        className="mt-2.5"
        disabled={daySet.size === 0}
        onClick={save}
      >
        Save schedule
      </Button>
    </DashCard>
  );
}
