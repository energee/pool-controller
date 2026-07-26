// Threshold check for the salt verdict bands (Pentair IntelliChlor ranges).
import { expect, test } from "bun:test";

import { saltBand } from "./constants";

test("saltBand thresholds", () => {
  expect(saltBand(2599)).toBe("very low");
  expect(saltBand(2600)).toBe("low");
  expect(saltBand(2999)).toBe("low");
  expect(saltBand(3000)).toBe("OK");
  expect(saltBand(4500)).toBe("OK");
  expect(saltBand(4501)).toBe("high");
});
