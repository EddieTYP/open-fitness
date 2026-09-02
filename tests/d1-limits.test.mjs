import assert from "node:assert/strict";
import test from "node:test";
import {
  D1_MAX_BOUND_PARAMETERS,
  chunkByParameterLimit,
} from "../lib/d1-limits.ts";

test("chunks IN-list values below D1's 100-parameter limit", () => {
  const chunks = chunkByParameterLimit(
    Array.from({ length: 205 }, (_, index) => index),
  );

  assert.deepEqual(chunks.map((chunk) => chunk.length), [100, 100, 5]);
});

test("chunks nutrition meal item inserts below D1's parameter limit", () => {
  const chunks = chunkByParameterLimit(
    Array.from({ length: 60 }, (_, index) => ({ index })),
    22,
  );

  assert.deepEqual(chunks.map((chunk) => chunk.length), [
    ...Array(15).fill(4),
  ]);
  assert.ok(
    chunks.every(
      (chunk) => chunk.length * 22 <= D1_MAX_BOUND_PARAMETERS,
    ),
  );
});

test("chunks the maximum combo item insert below D1's parameter limit", () => {
  const chunks = chunkByParameterLimit(
    Array.from({ length: 20 }, (_, index) => ({ index })),
    7,
  );

  assert.deepEqual(chunks.map((chunk) => chunk.length), [14, 6]);
  assert.ok(
    chunks.every(
      (chunk) => chunk.length * 7 <= D1_MAX_BOUND_PARAMETERS,
    ),
  );
});

test("rejects an invalid parameter count", () => {
  assert.throws(
    () => chunkByParameterLimit([1], 0),
    /positive integer/,
  );
});
