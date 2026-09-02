import assert from "node:assert/strict";
import test from "node:test";

import { quickMealTiming } from "../lib/nutrition-meal-timing.ts";

test("quick meal timing keeps exact time today and uses date-only for a backfill", () => {
  const now = new Date("2026-08-12T02:30:00.000Z");

  assert.deepEqual(quickMealTiming("2026-08-12", "Asia/Hong_Kong", now), {
    eatenAt: "2026-08-12T02:30:00.000Z",
    timePrecision: "exact",
  });
  assert.deepEqual(quickMealTiming("2026-08-11", "Asia/Hong_Kong", now), {
    eatenAt: null,
    timePrecision: "date_only",
  });
});
