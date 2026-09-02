import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertExistingPhaseIdsPreserved,
  deriveTrainingTemplateProposal,
  normaliseTrainingTemplateMutation,
  TrainingTemplateValidationError,
  version2TrainingTemplate,
} from "../lib/training-template.ts";

const emptyCycle = {
  version: 1,
  phases: [
    { id: "push", label: "Push Day", kind: "training" },
    { id: "pull", label: "Pull Day", kind: "training" },
    { id: "rest", label: "Rest", kind: "recovery" },
  ],
};

test("legacy profiles are exposed as a round-trippable v2 template", () => {
  assert.deepEqual(version2TrainingTemplate(emptyCycle), {
    version: 2,
    phases: [
      { id: "push", label: "Push Day", kind: "training", routine: [] },
      { id: "pull", label: "Pull Day", kind: "training", routine: [] },
      { id: "rest", label: "Rest", kind: "recovery", routine: [] },
    ],
  });
});

test("legacy duplicate and overlong labels become valid stable v2 labels", () => {
  const longLabel = "Long legacy phase ".repeat(6);
  const upgraded = version2TrainingTemplate({
    version: 1,
    phases: [
      { id: "legacy-phase-1", label: longLabel, kind: "training" },
      { id: "legacy-phase-2", label: longLabel, kind: "training" },
    ],
  });

  assert.equal(upgraded.phases[0].label.length, 80);
  assert.ok(upgraded.phases[1].label.endsWith(" (2)"));
  assert.ok(upgraded.phases[1].label.length <= 80);
  assert.notEqual(upgraded.phases[0].label, upgraded.phases[1].label);
});

test("history proposal fills empty training phases from only the latest session", () => {
  const proposal = deriveTrainingTemplateProposal(
    emptyCycle,
    [
      {
        sessionId: "PUSH|NEW",
        trainingPhaseId: "push",
        sessionTitle: "Push",
        startedAt: "2026-08-09T19:00:00+08:00",
        localDate: "2026-08-09",
      },
      {
        sessionId: "PUSH|OLD",
        trainingPhaseId: "push",
        sessionTitle: "Push",
        startedAt: "2026-08-01T19:00:00+08:00",
        localDate: "2026-08-01",
      },
      {
        sessionId: "PULL|1",
        trainingPhaseId: "pull",
        sessionTitle: "Pull",
        startedAt: "2026-08-08T19:00:00+08:00",
        localDate: "2026-08-08",
      },
    ],
    [
      {
        sessionId: "PUSH|NEW",
        exercise: "Machine Seated Chest Press",
        setNoSession: 1,
        weightKgReported: 20,
        reps: 12,
        setTypeManual: "Warm-up",
      },
      {
        sessionId: "PUSH|NEW",
        exercise: "Machine Seated Chest Press",
        setNoSession: 2,
        weightKgReported: 60,
        reps: 10,
        setTypeManual: "Working",
      },
      {
        sessionId: "PUSH|NEW",
        exercise: "Machine Seated Chest Press",
        setNoSession: 3,
        weightKgReported: 60,
        reps: 8,
        setTypeManual: "Working",
      },
      {
        sessionId: "PUSH|NEW",
        exercise: "Dumbbell Lateral Raise",
        setNoSession: 4,
        weightKgReported: 12.5,
        reps: 12,
        setTypeManual: null,
      },
      {
        sessionId: "PUSH|NEW",
        exercise: "Warm-up Only",
        setNoSession: 5,
        weightKgReported: 5,
        reps: 20,
        setTypeManual: "Warm-up",
      },
      {
        sessionId: "PUSH|OLD",
        exercise: "Old Exercise",
        setNoSession: 1,
        weightKgReported: 100,
        reps: 5,
        setTypeManual: "Working",
      },
      {
        sessionId: "PULL|1",
        exercise: "Cable Face Pull",
        setNoSession: 1,
        weightKgReported: 20,
        reps: 15,
        setTypeManual: null,
      },
    ],
  );

  assert.equal(proposal.template.version, 2);
  assert.deepEqual(
    proposal.template.phases.map((phase) => phase.id),
    ["push", "pull", "rest"],
  );
  assert.deepEqual(proposal.template.phases[0].routine, [
    {
      id: "slot-machine-seated-chest-press",
      label: "Machine Seated Chest Press",
      preferredExercise: "Machine Seated Chest Press",
      alternatives: [],
      targetSets: 2,
      targetReps: "8-10",
    },
    {
      id: "slot-dumbbell-lateral-raise",
      label: "Dumbbell Lateral Raise",
      preferredExercise: "Dumbbell Lateral Raise",
      alternatives: [],
      targetSets: 1,
      targetReps: "12",
    },
  ]);
  assert.equal(proposal.template.phases[0].routine[0].targetEffort, undefined);
  assert.equal(proposal.template.phases[2].routine.length, 0);
  assert.deepEqual(proposal.sources[0], {
    phaseId: "push",
    status: "derived_history",
    sessionId: "PUSH|NEW",
    sessionTitle: "Push",
    localDate: "2026-08-09",
  });
});

test("history proposal preserves an existing routine and does not overwrite it", () => {
  const existing = {
    version: 2,
    phases: [
      {
        id: "push",
        label: "Push Day",
        kind: "training",
        routine: [
          {
            id: "owner-slot",
            label: "Owner choice",
            preferredExercise: "Custom Press",
            alternatives: [],
            targetSets: 3,
          },
        ],
      },
    ],
  };
  const proposal = deriveTrainingTemplateProposal(existing, [], []);
  assert.deepEqual(proposal.template, existing);
  assert.deepEqual(proposal.sources, [
    { phaseId: "push", status: "kept_existing" },
  ]);
});

test("unlabelled ramp sets use the repeated working load instead of every set", () => {
  const proposal = deriveTrainingTemplateProposal(
    {
      version: 2,
      phases: [
        { id: "leg", label: "Leg Day", kind: "training", routine: [] },
      ],
    },
    [
      {
        sessionId: "LEG|1",
        trainingPhaseId: "leg",
        sessionTitle: "Leg Day",
        startedAt: "2026-08-09T19:00:00+08:00",
        localDate: "2026-08-09",
      },
    ],
    [
      [1, 20, 12],
      [2, 40, 10],
      [3, 60, 8],
      [4, 60, 8],
      [5, 60, 7],
    ].map(([setNoSession, weightKgReported, reps]) => ({
      sessionId: "LEG|1",
      exercise: "Barbell Back Squat",
      setNoSession,
      weightKgReported,
      reps,
      setTypeManual: null,
    })),
  );

  assert.equal(proposal.template.phases[0].routine[0].targetSets, 3);
  assert.equal(proposal.template.phases[0].routine[0].targetReps, "7-8");
});

test("latest history is selected by UTC instant rather than timestamp text", () => {
  const proposal = deriveTrainingTemplateProposal(
    {
      version: 2,
      phases: [
        { id: "push", label: "Push Day", kind: "training", routine: [] },
      ],
    },
    [
      {
        sessionId: "EARLIER",
        trainingPhaseId: "push",
        sessionTitle: "Earlier by UTC",
        startedAt: "2026-08-09T23:00:00+08:00",
        startedAtUtc: "2026-08-09T15:00:00.000Z",
        localDate: "2026-08-09",
      },
      {
        sessionId: "LATER",
        trainingPhaseId: "push",
        sessionTitle: "Later by UTC",
        startedAt: "2026-08-09T20:00:00+00:00",
        startedAtUtc: "2026-08-09T20:00:00.000Z",
        localDate: "2026-08-09",
      },
    ],
    [
      {
        sessionId: "EARLIER",
        exercise: "Earlier Exercise",
        setNoSession: 1,
        weightKgReported: 10,
        reps: 10,
        setTypeManual: "Working",
      },
      {
        sessionId: "LATER",
        exercise: "Later Exercise",
        setNoSession: 1,
        weightKgReported: 10,
        reps: 10,
        setTypeManual: "Working",
      },
    ],
  );

  assert.equal(
    proposal.template.phases[0].routine[0].preferredExercise,
    "Later Exercise",
  );
  assert.equal(proposal.sources[0].sessionId, "LATER");
});

test("malformed imported UTC values fall back to the source timestamp", () => {
  const proposal = deriveTrainingTemplateProposal(
    {
      version: 2,
      phases: [
        { id: "push", label: "Push Day", kind: "training", routine: [] },
      ],
    },
    [
      {
        sessionId: "VALID-OLDER",
        trainingPhaseId: "push",
        sessionTitle: "Valid older",
        startedAt: "2026-08-09T18:00:00+00:00",
        startedAtUtc: "2026-08-09T18:00:00.000Z",
        localDate: "2026-08-09",
      },
      {
        sessionId: "FALLBACK-LATER",
        trainingPhaseId: "push",
        sessionTitle: "Fallback later",
        startedAt: "2026-08-09T20:00:00+00:00",
        startedAtUtc: "not-a-time",
        localDate: "2026-08-09",
      },
    ],
    [
      {
        sessionId: "VALID-OLDER",
        exercise: "Older Exercise",
        setNoSession: 1,
        weightKgReported: 10,
        reps: 10,
        setTypeManual: "Working",
      },
      {
        sessionId: "FALLBACK-LATER",
        exercise: "Fallback Exercise",
        setNoSession: 1,
        weightKgReported: 10,
        reps: 10,
        setTypeManual: "Working",
      },
    ],
  );

  assert.equal(proposal.sources[0].sessionId, "FALLBACK-LATER");
});

test("unsupported historical exercise names are omitted with a warning", () => {
  const proposal = deriveTrainingTemplateProposal(
    {
      version: 2,
      phases: [
        { id: "pull", label: "Pull Day", kind: "training", routine: [] },
      ],
    },
    [
      {
        sessionId: "PULL|LONG",
        trainingPhaseId: "pull",
        sessionTitle: "Pull Day",
        startedAt: "2026-08-09T19:00:00+08:00",
        localDate: "2026-08-09",
      },
    ],
    [
      {
        sessionId: "PULL|LONG",
        exercise: "x".repeat(121),
        setNoSession: 1,
        weightKgReported: 20,
        reps: 10,
        setTypeManual: "Working",
      },
    ],
  );

  assert.deepEqual(proposal.template.phases[0].routine, []);
  assert.deepEqual(proposal.warnings, [
    {
      phaseId: "pull",
      code: "history_exercise_name_unsupported",
      count: 1,
    },
  ]);
});

test("proposal reports unsupported and capped exercises after the first 20 slots", () => {
  const rows = Array.from({ length: 21 }, (_, index) => ({
    sessionId: "PUSH|MANY",
    exercise: `Exercise ${index + 1}`,
    setNoSession: index + 1,
    weightKgReported: 10,
    reps: 10,
    setTypeManual: "Working",
  }));
  rows.push({
    sessionId: "PUSH|MANY",
    exercise: "x".repeat(121),
    setNoSession: 22,
    weightKgReported: 10,
    reps: 10,
    setTypeManual: "Working",
  });
  const proposal = deriveTrainingTemplateProposal(
    {
      version: 2,
      phases: [
        { id: "push", label: "Push Day", kind: "training", routine: [] },
      ],
    },
    [
      {
        sessionId: "PUSH|MANY",
        trainingPhaseId: "push",
        sessionTitle: "Push Day",
        startedAt: "2026-08-09T19:00:00+08:00",
        localDate: "2026-08-09",
      },
    ],
    rows,
  );

  assert.equal(proposal.template.phases[0].routine.length, 20);
  assert.deepEqual(proposal.warnings, [
    {
      phaseId: "push",
      code: "history_exercise_name_unsupported",
      count: 1,
    },
    {
      phaseId: "push",
      code: "history_routine_items_truncated",
      count: 1,
    },
  ]);
});

test("template mutation requires v2, exact fields and preserves phase identities", () => {
  const template = {
    version: 2,
    phases: [
      { id: "push", label: "Push Day", kind: "training", routine: [] },
      { id: "pull", label: "Pull Day", kind: "training", routine: [] },
      { id: "rest", label: "Rest", kind: "recovery", routine: [] },
    ],
  };
  assert.deepEqual(
    normaliseTrainingTemplateMutation({
      expectedUpdatedAt: "2026-08-10T01:00:00.000Z",
      template,
    }),
    { expectedUpdatedAt: "2026-08-10T01:00:00.000Z", template },
  );
  assert.deepEqual(
    normaliseTrainingTemplateMutation({
      expectedUpdatedAt: "2026-08-10T01:00:00.000Z",
      template: {
        version: 2,
        phases: [{ id: "push", label: "Push Day", kind: "training" }],
      },
    }).template.phases[0].routine,
    [],
  );
  assert.throws(
    () =>
      normaliseTrainingTemplateMutation({
        expectedUpdatedAt: "x",
        template: emptyCycle,
      }),
    TrainingTemplateValidationError,
  );
  assert.throws(
    () =>
      normaliseTrainingTemplateMutation({
        expectedUpdatedAt: "x",
        template,
        confirmed: true,
      }),
    /confirmed is not supported/,
  );
  assert.throws(
    () =>
      assertExistingPhaseIdsPreserved(emptyCycle, {
        version: 2,
        phases: [
          { id: "push", label: "Push Day", kind: "training", routine: [] },
        ],
      }),
    /cannot remove existing phases: pull, rest/,
  );
});

test("training-template route authenticates, proposes effective history and safely writes", async () => {
  const route = await readFile(
    new URL("../app/api/fitness/training-template/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(route, /getApiActor\(request\)/);
  assert.match(route, /effectiveWorkoutRecords/);
  assert.match(route, /deriveTrainingTemplateProposal/);
  assert.match(route, /startedAtUtc: workoutSessions\.startedAtUtc/);
  assert.match(
    route,
    /orderBy\([\s\S]*coalesce\(julianday\(\$\{workoutSessions\.startedAtUtc\}\), julianday\(\$\{workoutSessions\.startedAt\}\)\)[\s\S]*\.limit\(HISTORY_SESSION_LIMIT\)/,
  );
  assert.match(route, /\.limit\(HISTORY_SESSION_LIMIT\)/);
  assert.match(route, /chunkByParameterLimit\(sessionIds\)/);
  assert.match(route, /inArray\(workoutSets\.sessionId, sessionIdChunk\)/);
  assert.match(route, /inferSessionTrainingPhaseId/);
  assert.match(route, /normaliseTrainingTemplateMutation/);
  assert.match(route, /assertStablePhaseKinds/);
  assert.match(route, /assertExistingPhaseIdsPreserved/);
  assert.match(route, /eq\(profile\.updatedAt, mutation\.expectedUpdatedAt\)/);
  assert.match(route, /inferTrainingPhaseBackfills/);
  assert.match(route, /const correctedSessionIds = new Set/);
  assert.match(
    route,
    /projectedBackfills\.appliedCorrections[\s\S]*targetScope === "workout_session"/,
  );
  assert.match(route, /!correctedSessionIds\.has\(session\.sessionId\)/);
  assert.match(route, /entityType: ENTITY_TYPE/);
  assert.match(route, /const racedReplay = await findIdempotentReplay/);
  assert.match(route, /TRAINING_TEMPLATE_CONFLICT/);
  assert.match(route, /IDEMPOTENCY_KEY_CONFLICT/);
  assert.match(route, /Training template readback mismatch/);
  assert.match(route, /const readbackRows = await tx/);
  assert.match(
    route,
    /JSON\.stringify\(readbackTemplate\) !== JSON\.stringify\(mutation\.template\)/,
  );
  assert.match(route, /cache-control.*no-store/s);
  assert.doesNotMatch(route, /actor\.kind !== "owner"/);
});
