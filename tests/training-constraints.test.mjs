import assert from "node:assert/strict";
import test from "node:test";

import {
  exerciseConstraintState,
  exerciseMatchesConstraintItem,
} from "../lib/training-constraints.ts";

test("constraint applicability follows generic names and alternatives", () => {
  assert.equal(
    exerciseMatchesConstraintItem(
      "Machine Seated Chest Press",
      "Machine Chest Press",
    ),
    true,
  );
  assert.equal(
    exerciseMatchesConstraintItem(
      "Machine Shoulder Press",
      "Light Machine Shoulder Press",
    ),
    true,
  );
  assert.equal(
    exerciseMatchesConstraintItem("Cable Fly High", "Fly / Lateral Raise"),
    true,
  );
  assert.equal(
    exerciseMatchesConstraintItem("Cable Lat Pulldown", "Pull movements"),
    true,
  );
  assert.equal(
    exerciseMatchesConstraintItem("Barbell Back Squat", "Incline Press"),
    false,
  );
});

test("a matching paused constraint dominates broader conditional guidance", () => {
  const state = exerciseConstraintState("Machine Shoulder Press", [
    {
      item: "Shoulder Press",
      status: "Conditional",
      operatingRule: "Use a comfortable range",
    },
    {
      item: "Machine Shoulder Press",
      status: "Paused",
      operatingRule: "Do not perform this movement",
    },
  ]);

  assert.equal(state.matching.length, 2);
  assert.equal(state.paused, true);
  assert.equal(state.conditional, false);
  assert.deepEqual(state.rules, [
    "Use a comfortable range",
    "Do not perform this movement",
  ]);
});

test("resolved constraints preserve history without leaking stale warnings", () => {
  const resolved = {
    item: "Barbell Bench Press",
    status: "Resolved",
    operatingRule: "Do not perform this movement",
  };
  const state = exerciseConstraintState("Barbell Bench Press", [resolved]);

  assert.deepEqual(state.matching, [resolved]);
  assert.equal(state.paused, false);
  assert.equal(state.conditional, false);
  assert.deepEqual(state.rules, []);
});

test("legacy descriptive active statuses remain visible as item-level guidance", () => {
  const state = exerciseConstraintState("Cable Fly High", [
    {
      item: "Fly / Lateral Raise",
      status: "Allowed if symptom-free",
      operatingRule: "Stop if symptoms return",
    },
  ]);

  assert.equal(state.paused, false);
  assert.equal(state.conditional, true);
  assert.deepEqual(state.rules, ["Stop if symptoms return"]);
});

test("unresolved wording cannot silently clear an active constraint", () => {
  for (const status of ["Unresolved", "Not resolved"]) {
    const state = exerciseConstraintState("Barbell Bench Press", [
      {
        item: "Barbell Bench Press",
        status,
        operatingRule: "Stop if symptoms return",
      },
    ]);

    assert.equal(state.paused, false, status);
    assert.equal(state.conditional, true, status);
    assert.deepEqual(state.rules, ["Stop if symptoms return"], status);
  }
});
