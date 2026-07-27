// Runs with `bun test`. Covers the 12-hour edge cases (noon/midnight/wrap).
import { expect, test } from "bun:test";

import { clock12, time12 } from "./format";

test("time12 24h→12h", () => {
  expect(time12("08:00")).toBe("8:00 AM");
  expect(time12("17:00")).toBe("5:00 PM");
  expect(time12("00:00")).toBe("12:00 AM");
  expect(time12("12:00")).toBe("12:00 PM");
  expect(time12("12:30")).toBe("12:30 PM");
  expect(time12("2026-06-17 14:30")).toBe("2026-06-17 2:30 PM");
  expect(time12("")).toBe("");
  expect(time12(null)).toBe("");
});

test("clock12 names the day relative to now", () => {
  const now = new Date(2026, 6, 26, 10, 13); // Sun 2026-07-26 10:13 local
  expect(clock12("2026-07-26 10:13", now)).toBe("Today 10:13 AM");
  expect(clock12("2026-07-26 00:05", now)).toBe("Today 12:05 AM");
  expect(clock12("2026-07-26 12:00", now)).toBe("Today 12:00 PM");
  expect(clock12("2026-07-25 23:58", now)).toBe("Yesterday 11:58 PM");
  expect(clock12("2026-07-27 06:00", now)).toBe("Tomorrow 6:00 AM");
  // Further out, spell the date; exact wording is locale-dependent.
  expect(clock12("2026-07-20 08:30", now)).toContain("8:30 AM");
  expect(clock12("2026-07-20 08:30", now)).toContain("20");
  // A bare clock (no date) falls through to time12; junk passes through.
  expect(clock12("17:00", now)).toBe("5:00 PM");
  expect(clock12(null, now)).toBe("");
});
