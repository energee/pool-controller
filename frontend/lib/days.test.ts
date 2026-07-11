// Runs with `bun test`. Covers the schedule day-chip round-trip.
import { expect, test } from "bun:test";

import { daysToSet, setToDays } from "./days";

test("daysToSet decodes controller day lists", () => {
  expect(setToDays(daysToSet(["Every day"]))).toBe("every");
  expect(setToDays(daysToSet(["Mon", "Wed", "Fri"]))).toBe("mon,wed,fri");
  expect(daysToSet([]).size).toBe(0);
  expect(daysToSet(undefined).size).toBe(0);
});

test("setToDays collapses a full week to 'every'", () => {
  const all = daysToSet(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
  expect(all.size).toBe(7);
  expect(setToDays(all)).toBe("every");
  expect(setToDays(new Set(["sat", "sun"]))).toBe("sun,sat"); // re-ordered Sun-first
});
