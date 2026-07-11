// Runs with `bun test`. Covers the 12-hour edge cases (noon/midnight/wrap).
import { expect, test } from "bun:test";

import { time12 } from "./format";

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
