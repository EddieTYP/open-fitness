import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  normaliseTrainingCourseOverride,
  trainingCourseFingerprint,
} from "../lib/training-course.ts";

const fingerprint = "a".repeat(64);

test("training course override requires one exact bounded row per slot", () => {
  assert.deepEqual(
    normaliseTrainingCourseOverride({
      scope: "date",
      phaseId: "leg",
      date: "2099-04-21",
      expectedPlanFingerprint: fingerprint,
      items: [
        {
          slotId: "history-0123456789abcdef01234567",
          exercise: "Barbell Back Squat",
          prescription: "2 × 5",
          loadGuidance: "92.5 kg",
          effort: "RIR 3-4",
        },
      ],
    }),
    {
      scope: "date",
      phaseId: "leg",
      date: "2099-04-21",
      expectedPlanFingerprint: fingerprint,
      items: [
        {
          slotId: "history-0123456789abcdef01234567",
          exercise: "Barbell Back Squat",
          prescription: "2 × 5",
          loadGuidance: "92.5 kg",
          effort: "RIR 3-4",
        },
      ],
    },
  );
  assert.throws(
    () =>
      normaliseTrainingCourseOverride({
        scope: "date",
        phaseId: "leg",
        date: "2099-04-21",
        expectedPlanFingerprint: fingerprint,
        items: [
          {
            slotId: "squat",
            exercise: "Barbell Back Squat",
            prescription: "2 × 5",
            loadGuidance: "92.5 kg",
            effort: "RIR 3-4",
          },
          {
            slotId: "squat",
            exercise: "Barbell Back Squat",
            prescription: "2 × 5",
            loadGuidance: "92.5 kg",
            effort: "RIR 3-4",
          },
        ],
      }),
    /duplicate slotId/,
  );
});

test("next normal course override requires progression evidence", () => {
  assert.deepEqual(
    normaliseTrainingCourseOverride({
      scope: "next_normal_occurrence",
      phaseId: "push",
      trainingBlockId: "TRAINING-BLOCK|synthetic|1",
      sourceSessionId: "SYNTHETIC|2099-04-20|push",
      expectedProgressionFingerprint: fingerprint,
      items: [
        {
          slotId: "press",
          exercise: "Machine Chest Press",
          prescription: "3 × 8-10",
          loadGuidance: "62.5 kg",
          effort: "RIR 2-3",
        },
      ],
    }),
    {
      scope: "next_normal_occurrence",
      phaseId: "push",
      trainingBlockId: "TRAINING-BLOCK|synthetic|1",
      sourceSessionId: "SYNTHETIC|2099-04-20|push",
      expectedProgressionFingerprint: fingerprint,
      items: [
        {
          slotId: "press",
          exercise: "Machine Chest Press",
          prescription: "3 × 8-10",
          loadGuidance: "62.5 kg",
          effort: "RIR 2-3",
        },
      ],
    },
  );
  assert.throws(
    () =>
      normaliseTrainingCourseOverride({
        scope: "next_normal_occurrence",
        phaseId: "push",
        trainingBlockId: "TRAINING-BLOCK|synthetic|1",
        sourceSessionId: "SYNTHETIC|2099-04-20|push",
        items: [
          {
            slotId: "press",
            exercise: "Machine Chest Press",
            prescription: "3 × 8-10",
            loadGuidance: "62.5 kg",
            effort: "RIR 2-3",
          },
        ],
      }),
    /expectedProgressionFingerprint must be a string/,
  );
});

test("planned session requires an exact deload or test plan", () => {
  const planned = normaliseTrainingCourseOverride({
    scope: "planned_session",
    phaseId: "leg",
    date: "2099-04-21",
    trainingBlockId: "TRAINING-BLOCK|synthetic|1",
    sessionIntent: "deload",
    expectedPlanFingerprint: fingerprint,
    items: [
      {
        slotId: "squat",
        exercise: "Barbell Back Squat",
        prescription: "2 × 5",
        loadGuidance: "70 kg",
        effort: "RIR 4",
      },
    ],
  });
  assert.equal(planned.scope, "planned_session");
  assert.equal(planned.sessionIntent, "deload");
  assert.throws(
    () =>
      normaliseTrainingCourseOverride({
        ...planned,
        sessionIntent: "normal",
      }),
    /sessionIntent must be deload or test/,
  );
  assert.throws(
    () =>
      normaliseTrainingCourseOverride({
        ...planned,
        date: undefined,
      }),
    /date must be a string/,
  );
});

test("confirmed next-course evidence is evaluated against the immutable block snapshot", () => {
  const route = readFileSync(
    new URL("../app/api/fitness/training-course/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    route,
    /parseCycle\(\s*storedProfile\.trainingCycle,\s*activeBlock\.trainingCycleSnapshot,\s*\)/,
  );
  assert.doesNotMatch(
    route,
    /parseCycle\(\s*storedProfile\.trainingCycle,\s*storedProfile\.trainingCycleConfig,\s*\)/,
  );
});

test("training course fingerprint changes with rendered guidance", () => {
  const plan = {
    planningDate: "2099-04-21",
    phaseId: "leg",
    items: [
      {
        phase: "primary",
        slotId: "squat",
        exercise: { kind: "source", text: "Barbell Back Squat" },
        prescription: { kind: "source", text: "3 × 5" },
        loadGuidance: { kind: "source", text: "102.5 kg" },
        effort: { kind: "source", text: "RIR 2-3" },
      },
    ],
  };
  const before = trainingCourseFingerprint(plan);
  const after = trainingCourseFingerprint({
    ...plan,
    items: [
      {
        ...plan.items[0],
        prescription: { kind: "source", text: "2 × 5" },
      },
    ],
  });
  assert.match(before, /^[a-f0-9]{64}$/);
  assert.notEqual(before, after);
});
