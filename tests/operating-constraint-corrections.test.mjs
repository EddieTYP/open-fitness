import assert from "node:assert/strict";
import test from "node:test";

import {
  normaliseOperatingConstraintStatus,
  projectOperatingConstraintCorrections,
} from "../lib/operating-constraint-projection.mjs";

const sourceConstraint = {
  constraintId: "CONSTRAINT-01",
  item: "Barbell Bench Press",
  status: "Paused",
  operatingRule: "Do not perform while shoulder pain is active",
  effectiveDate: "2026-07-29",
  source: "Owner report",
};

function correction(overrides = {}) {
  return {
    correctionId: "CORRECTION|RESOLVED",
    effectiveDate: "2026-08-08",
    targetScope: "operating_constraint",
    targetKey: sourceConstraint.constraintId,
    fieldName: "status",
    correctedValue: "Resolved",
    recordedAt: "2026-08-11T06:00:00.000Z",
    ...overrides,
  };
}

test("constraint status corrections are append-only and effective as of date", () => {
  const resolved = correction();
  const futurePause = correction({
    correctionId: "CORRECTION|FUTURE",
    effectiveDate: "2026-08-12",
    correctedValue: "Paused",
    recordedAt: "2026-08-12T06:00:00.000Z",
  });

  const before = projectOperatingConstraintCorrections(
    [sourceConstraint],
    [resolved, futurePause],
    "2026-08-07",
  );
  assert.equal(before.constraints[0].status, "Paused");
  assert.deepEqual(before.appliedCorrections, []);

  const after = projectOperatingConstraintCorrections(
    [sourceConstraint],
    [resolved, futurePause],
    "2026-08-11",
  );
  assert.equal(after.constraints[0].status, "Resolved");
  assert.equal(after.appliedCorrections[0].correctionId, resolved.correctionId);

  const future = projectOperatingConstraintCorrections(
    [sourceConstraint],
    [resolved, futurePause],
    "2026-08-12",
  );
  assert.equal(future.constraints[0].status, "Paused");
  assert.equal(
    future.appliedCorrections[0].correctionId,
    futurePause.correctionId,
  );
  assert.equal(sourceConstraint.status, "Paused");
});

test("same-day constraint corrections break ties deterministically", () => {
  const recordedAt = "2026-08-11T06:00:00.000Z";
  const projected = projectOperatingConstraintCorrections(
    [sourceConstraint],
    [
      correction({
        correctionId: "CORRECTION|A",
        correctedValue: "Conditional",
        recordedAt,
      }),
      correction({
        correctionId: "CORRECTION|B",
        correctedValue: "Resolved",
        recordedAt,
      }),
    ],
    "2026-08-11",
  );

  assert.equal(projected.constraints[0].status, "Resolved");
  assert.equal(
    projected.appliedCorrections[0].correctionId,
    "CORRECTION|B",
  );
});

test("recorded-at ordering compares instants across timezone offsets", () => {
  const projected = projectOperatingConstraintCorrections(
    [sourceConstraint],
    [
      correction({
        correctionId: "CORRECTION|MIDNIGHT-UTC",
        correctedValue: "Conditional",
        recordedAt: "2026-08-11T08:00:00+08:00",
      }),
      correction({
        correctionId: "CORRECTION|ONE-UTC",
        correctedValue: "Resolved",
        recordedAt: "2026-08-11T01:00:00.000Z",
      }),
    ],
    "2026-08-11",
  );

  assert.equal(projected.constraints[0].status, "Resolved");
  assert.equal(
    projected.appliedCorrections[0].correctionId,
    "CORRECTION|ONE-UTC",
  );
});

test("malformed or unrelated corrections cannot alter a constraint", () => {
  const projected = projectOperatingConstraintCorrections(
    [sourceConstraint],
    [
      correction({ correctedValue: "Definitely fine" }),
      correction({ targetKey: "CONSTRAINT-OTHER" }),
      correction({ fieldName: "operating_rule" }),
      correction({ targetScope: "session_note" }),
    ],
    "2026-08-11",
  );

  assert.equal(projected.constraints[0].status, "Paused");
  assert.deepEqual(projected.appliedCorrections, []);
  assert.equal(normaliseOperatingConstraintStatus("  PAUSED "), "Paused");
  assert.equal(normaliseOperatingConstraintStatus("conditional"), "Conditional");
  assert.equal(normaliseOperatingConstraintStatus(" resolved "), "Resolved");
  assert.equal(normaliseOperatingConstraintStatus("fine"), null);
});

test("future-dated source constraints are absent from earlier projections", () => {
  const projected = projectOperatingConstraintCorrections(
    [
      sourceConstraint,
      {
        ...sourceConstraint,
        constraintId: "CONSTRAINT-FUTURE",
        item: "Future movement",
        effectiveDate: "2026-08-12",
      },
    ],
    [],
    "2026-08-11",
  );

  assert.deepEqual(
    projected.constraints.map((constraint) => constraint.constraintId),
    [sourceConstraint.constraintId],
  );
});
