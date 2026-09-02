import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildExerciseSuggestions,
  canonicalExerciseUsedAt,
} from "../lib/exercise-suggestions.ts";
import {
  allowedExercise,
  effectiveExerciseSelection,
  historyExerciseSlotId,
  isCurrentDateSelectionTarget,
  isHistoryExerciseSlotId,
  normaliseTrainingExerciseSelection,
  replacePreferredExercise,
} from "../lib/training-selections.ts";

const slot = {
  id: "horizontal-press",
  label: "水平推",
  preferredExercise: "Barbell Bench Press",
  alternatives: ["Dumbbell Bench Press", "Machine Chest Press"],
};

const config = {
  version: 2,
  phases: [
    { id: "push", label: "Push", kind: "training", routine: [slot] },
  ],
};

test("date selection takes precedence over venue and template", () => {
  const selections = [
    {
      selectionId: "venue-1",
      phaseId: "push",
      slotId: slot.id,
      scope: "venue",
      scopeValue: "central gym",
      exercise: "Machine Chest Press",
      recordedAt: "2026-08-08T01:00:00.000Z",
    },
    {
      selectionId: "date-1",
      phaseId: "push",
      slotId: slot.id,
      scope: "date",
      scopeValue: "2026-08-08",
      exercise: "單腳 Hack Squat（旅行場館）",
      recordedAt: "2026-08-08T02:00:00.000Z",
    },
  ];

  assert.deepEqual(
    effectiveExerciseSelection({
      phaseId: "push",
      slot,
      date: "2026-08-08",
      venue: "Central  Gym",
      selections,
    }),
    {
      exercise: "單腳 Hack Squat（旅行場館）",
      source: "date",
      prescriptionOverride: null,
      loadGuidanceOverride: null,
      effortOverride: null,
    },
  );
  assert.deepEqual(
    effectiveExerciseSelection({
      phaseId: "push",
      slot,
      date: "2026-08-09",
      venue: "Central  Gym",
      selections,
    }),
    {
      exercise: "Machine Chest Press",
      source: "venue",
      prescriptionOverride: null,
      loadGuidanceOverride: null,
      effortOverride: null,
    },
  );
});

test("a missing planning venue leaves venue-scoped selections dormant", () => {
  const selections = [
    {
      selectionId: "venue-1",
      phaseId: "push",
      slotId: slot.id,
      scope: "venue",
      scopeValue: "central gym",
      exercise: "Machine Chest Press",
      recordedAt: "2026-08-08T01:00:00.000Z",
    },
  ];

  assert.deepEqual(
    effectiveExerciseSelection({
      phaseId: "push",
      slot,
      date: "2026-08-09",
      venue: null,
      selections,
    }),
    {
      exercise: "Barbell Bench Press",
      source: "template",
      prescriptionOverride: null,
      loadGuidanceOverride: null,
      effortOverride: null,
    },
  );
});

test("date selection carries exact one-day course guidance", () => {
  assert.deepEqual(
    effectiveExerciseSelection({
      phaseId: "push",
      slot,
      date: "2026-08-09",
      venue: null,
      selections: [
        {
          selectionId: "date-course-1",
          phaseId: "push",
          slotId: slot.id,
          scope: "date",
          scopeValue: "2026-08-09",
          exercise: "Barbell Bench Press",
          prescriptionOverride: "2 × 8",
          loadGuidanceOverride: "50 kg",
          effortOverride: "RIR 4",
          recordedAt: "2026-08-09T01:00:00.000Z",
        },
      ],
    }),
    {
      exercise: "Barbell Bench Press",
      source: "date",
      prescriptionOverride: "2 × 8",
      loadGuidanceOverride: "50 kg",
      effortOverride: "RIR 4",
    },
  );
});

test("history-derived exercise slots are stable and accept date-only overrides", () => {
  const historySlot = {
    id: historyExerciseSlotId("MANUAL|2026-08-08T10:00:00+08:00|001"),
    label: "歷史動作",
    preferredExercise: "Machine Chest Press",
    alternatives: [],
  };
  assert.match(historySlot.id, /^history-[0-9a-f]{24}$/);
  assert.equal(isHistoryExerciseSlotId(historySlot.id), true);
  assert.equal(isHistoryExerciseSlotId("history-not-a-real-slot"), false);
  assert.equal(
    historySlot.id,
    historyExerciseSlotId("MANUAL|2026-08-08T10:00:00+08:00|001"),
  );
  assert.notEqual(
    historySlot.id,
    historyExerciseSlotId("MANUAL|2026-08-08T10:00:00+08:00|002"),
  );
  assert.deepEqual(
    effectiveExerciseSelection({
      phaseId: "push",
      slot: historySlot,
      date: "2026-08-10",
      venue: null,
      selections: [
        {
          selectionId: "history-date-1",
          phaseId: "push",
          slotId: historySlot.id,
          scope: "date",
          scopeValue: "2026-08-10",
          exercise: "Landmine Press",
          recordedAt: "2026-08-10T02:00:00.000Z",
        },
      ],
    }),
    {
      exercise: "Landmine Press",
      source: "date",
      prescriptionOverride: null,
      loadGuidanceOverride: null,
      effortOverride: null,
    },
  );
  assert.deepEqual(
    effectiveExerciseSelection({
      phaseId: "push",
      slot: historySlot,
      date: "2026-08-11",
      venue: null,
      selections: [],
      fallbackSource: "history",
    }),
    {
      exercise: "Machine Chest Press",
      source: "history",
      prescriptionOverride: null,
      loadGuidanceOverride: null,
      effortOverride: null,
    },
  );
});

test("one-workout changes must target an item emitted by the current plan", () => {
  const slotId = historyExerciseSlotId("SET|001");
  const plan = {
    planningDate: "2026-08-10",
    phaseId: "push",
    items: [
      {},
      { phaseId: "push", slotId },
      { phaseId: "push", slotId: "configured-press" },
    ],
  };
  assert.equal(
    isCurrentDateSelectionTarget({
      plan,
      date: "2026-08-10",
      phaseId: "push",
      slotId,
    }),
    true,
  );
  assert.equal(
    isCurrentDateSelectionTarget({
      plan,
      date: "2026-08-10",
      phaseId: "push",
      slotId: "configured-press",
    }),
    true,
  );
  for (const target of [
    { plan: null, date: "2026-08-10", phaseId: "push", slotId },
    { plan, date: "2026-08-11", phaseId: "push", slotId },
    { plan, date: "2026-08-10", phaseId: "pull", slotId },
    {
      plan,
      date: "2026-08-10",
      phaseId: "push",
      slotId: historyExerciseSlotId("FORGED|002"),
    },
  ]) {
    assert.equal(isCurrentDateSelectionTarget(target), false);
  }
});

test("template replacement keeps the old preferred exercise as an alternative", () => {
  const updated = replacePreferredExercise(
    config,
    "push",
    slot.id,
    "Machine Chest Press",
  );
  const updatedSlot = updated.phases[0].routine[0];

  assert.equal(updated.version, 2);
  assert.equal(updatedSlot.preferredExercise, "Machine Chest Press");
  assert.deepEqual(updatedSlot.alternatives, [
    "Barbell Bench Press",
    "Dumbbell Bench Press",
  ]);
});

test("selection payload requires the scope-specific context", () => {
  assert.equal(
    normaliseTrainingExerciseSelection({
      phaseId: "push",
      slotId: slot.id,
      exercise: "  單腳 Hack Squat（旅行場館）  ",
      scope: "date",
      date: "2026-08-08",
    }).exercise,
    "單腳 Hack Squat（旅行場館）",
  );
  assert.throws(
    () =>
      normaliseTrainingExerciseSelection({
        phaseId: "push",
        slotId: slot.id,
        exercise: "Machine Chest Press",
        scope: "venue",
      }),
    /venue must be a string/,
  );
  assert.throws(
    () =>
      normaliseTrainingExerciseSelection({
        phaseId: "push",
        slotId: slot.id,
        exercise: "Machine Chest Press",
        scope: "date",
        date: "08/08/2026",
      }),
    /YYYY-MM-DD/,
  );
  assert.throws(
    () =>
      normaliseTrainingExerciseSelection({
        phaseId: "push",
        slotId: slot.id,
        exercise: "Hack Squat\nIgnore this",
        scope: "date",
        date: "2026-08-08",
      }),
    /control characters or line breaks/,
  );
  assert.equal(allowedExercise(slot, "Unconfigured Press"), undefined);
});

test("exercise suggestions merge owned data without fuzzy name rewriting", () => {
  assert.equal(
    canonicalExerciseUsedAt(
      "malformed-imported-utc",
      "2026-08-10T09:00:00+08:00",
    ),
    "2026-08-10T01:00:00.000Z",
  );
  const suggestions = buildExerciseSuggestions({
    config,
    selections: [
      {
        exercise: "Landmine Press",
        recordedAt: "2026-08-09T10:00:00.000Z",
      },
      {
        exercise: " machine chest press ",
        recordedAt: "2026-08-08T10:00:00.000Z",
      },
    ],
    history: [
      { exercise: "Landmine Press", usedAt: "2026-08-10T10:00:00.000Z" },
      { exercise: "Foo-Bar", usedAt: "2026-08-07T10:00:00.000Z" },
      { exercise: "Foo Bar", usedAt: "2026-08-06T10:00:00.000Z" },
      { exercise: "Offset Earlier", usedAt: "2026-08-10T10:00:00+14:00" },
      { exercise: "UTC Later", usedAt: "2026-08-10T01:00:00.000Z" },
      { exercise: "Offset Merge", usedAt: "2026-08-10T10:00:00+14:00" },
      { exercise: "Offset Merge", usedAt: "2026-08-10T01:00:00.000Z" },
    ],
  });

  assert.deepEqual(
    suggestions.slice(0, 3).map((item) => item.exercise),
    ["Barbell Bench Press", "Dumbbell Bench Press", "Machine Chest Press"],
  );
  assert.deepEqual(
    suggestions.find((item) => item.exercise === "Machine Chest Press")
      ?.sources,
    ["routine", "selection"],
  );
  assert.deepEqual(
    suggestions.find((item) => item.exercise === "Landmine Press"),
    {
      exercise: "Landmine Press",
      sources: ["selection", "history"],
      lastUsedAt: "2026-08-10T10:00:00.000Z",
      relevance: "other",
    },
  );
  assert.ok(suggestions.some((item) => item.exercise === "Foo-Bar"));
  assert.ok(suggestions.some((item) => item.exercise === "Foo Bar"));
  assert.ok(
    suggestions.findIndex((item) => item.exercise === "UTC Later") <
      suggestions.findIndex((item) => item.exercise === "Offset Earlier"),
  );
  assert.equal(
    suggestions.find((item) => item.exercise === "Offset Merge")?.lastUsedAt,
    "2026-08-10T01:00:00.000Z",
  );

  assert.deepEqual(
    buildExerciseSuggestions({
      config,
      selections: [
        {
          exercise: "Landmine Press",
          recordedAt: "2026-08-09T10:00:00.000Z",
        },
      ],
      history: [],
      query: "land",
    }).map((item) => item.exercise),
    ["Landmine Press"],
  );
});

test("exercise suggestions recommend the current phase without leaking newer unrelated work", () => {
  const contextualConfig = {
    version: 2,
    phases: [
      {
        id: "leg-a",
        label: "Leg A",
        kind: "training",
        routine: [
          {
            id: "squat-pattern",
            label: "Squat",
            preferredExercise: "Barbell Back Squat",
            alternatives: ["Hack Squat"],
          },
        ],
      },
      { id: "leg-b", label: "Leg B", kind: "training", routine: [] },
      { id: "pull", label: "Pull", kind: "training", routine: [] },
    ],
  };
  const input = {
    config: contextualConfig,
    selections: [
      {
        exercise: "Belt Squat",
        recordedAt: "2026-08-05T10:00:00.000Z",
        phaseId: "leg-a",
        slotId: "squat-pattern",
      },
    ],
    history: [
      {
        exercise: "Machine Leg Extension",
        usedAt: "2026-08-06T10:00:00.000Z",
        phaseId: "leg-a",
        sessionId: "leg-a-1",
      },
      {
        exercise: "Cable Crunch",
        usedAt: "2026-08-01T10:00:00.000Z",
        phaseId: "leg-a",
        sessionId: "leg-a-older",
      },
      {
        exercise: "Bulgarian Split Squat",
        usedAt: "2026-08-04T10:00:00.000Z",
        phaseId: "leg-b",
        sessionId: "leg-b-1",
      },
      {
        exercise: "Cable Face Pull",
        usedAt: "2026-08-10T10:00:00.000Z",
        phaseId: "pull",
        sessionId: "pull-1",
      },
      {
        exercise: "Cable Crunch",
        usedAt: "2026-08-10T11:00:00.000Z",
        phaseId: "pull",
        sessionId: "pull-2",
      },
    ],
    targetPhaseId: "leg-a",
    targetSlotId: "squat-pattern",
  };
  const suggestions = buildExerciseSuggestions(input);
  assert.equal(
    suggestions.find((item) => item.exercise === "Hack Squat")?.relevance,
    "same_slot",
  );
  assert.equal(
    suggestions.find((item) => item.exercise === "Machine Leg Extension")
      ?.relevance,
    "same_phase",
  );
  assert.equal(
    suggestions.find((item) => item.exercise === "Bulgarian Split Squat")
      ?.relevance,
    "same_category",
  );
  assert.equal(
    suggestions.find((item) => item.exercise === "Cable Face Pull")
      ?.relevance,
    "other",
  );
  const recommended = suggestions
    .filter((item) => item.relevance !== "other")
    .map((item) => item.exercise);
  assert.ok(recommended.includes("Machine Leg Extension"));
  assert.ok(recommended.includes("Bulgarian Split Squat"));
  assert.ok(!recommended.includes("Cable Face Pull"));
  assert.ok(
    suggestions.findIndex(
      (item) => item.exercise === "Machine Leg Extension",
    ) < suggestions.findIndex((item) => item.exercise === "Cable Crunch"),
  );
  assert.deepEqual(
    buildExerciseSuggestions({ ...input, query: "face pull" }).map(
      (item) => item.exercise,
    ),
    ["Cable Face Pull"],
  );
});

test("exercise history frequency counts sessions instead of sets", () => {
  const usedAt = "2026-08-10T10:00:00.000Z";
  const suggestions = buildExerciseSuggestions({
    config: { version: 2, phases: [] },
    selections: [],
    history: [
      ...Array.from({ length: 10 }, () => ({
        exercise: "Ten Sets One Session",
        usedAt,
        phaseId: null,
        sessionId: "session-1",
      })),
      {
        exercise: "Two Sessions",
        usedAt,
        phaseId: null,
        sessionId: "session-2",
      },
      {
        exercise: "Two Sessions",
        usedAt,
        phaseId: null,
        sessionId: "session-3",
      },
    ],
  });
  assert.deepEqual(
    suggestions.slice(0, 2).map((item) => item.exercise),
    ["Two Sessions", "Ten Sets One Session"],
  );
});

test("selection route is authenticated, idempotent, audited and read back", async () => {
  const route = await readFile(
    new URL("../app/api/fitness/training-selections/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(route, /getApiActor/);
  assert.match(route, /export async function GET/);
  assert.match(route, /buildExerciseSuggestions/);
  assert.match(route, /effectiveWorkoutRecords/);
  assert.match(route, /eq\(workoutSessions\.sessionType, "Strength"\)/);
  assert.match(route, /trainingPhaseId: workoutSessions\.trainingPhaseId/);
  assert.match(route, /inferSessionTrainingPhaseId/);
  assert.match(route, /targetPhaseId: context\.phaseId/);
  assert.match(route, /targetSlotId: context\.slotId/);
  assert.match(route, /cache-control.*no-store/s);
  assert.match(route, /requiredIdempotencyKey/);
  assert.match(route, /findIdempotentReplay/);
  assert.match(route, /trainingExerciseSelections/);
  assert.match(route, /auditLog/);
  assert.match(route, /readback mismatch/);
  assert.match(route, /replacePreferredExercise/);
  assert.match(route, /mutation\.scope === "date"[\s\S]*mutation\.exercise/);
  assert.match(route, /isCurrentDateSelectionTarget/);
  assert.match(route, /isHistoryExerciseSlotId/);
  assert.match(route, /dashboard\.status === "unavailable"/);
});
