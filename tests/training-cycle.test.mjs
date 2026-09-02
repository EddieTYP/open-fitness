import assert from "node:assert/strict";
import test from "node:test";

import {
  cycleCompletionEvidence,
  inferSessionTrainingPhaseId,
  inferNextCyclePhase,
  matchedCompletedTrainingPhase,
  normaliseTrainingCycleConfig,
  parseCycle,
  sessionMatchesCyclePhase,
  trainingAdjustmentFor,
} from "../lib/training-cycle.ts";

const cycle = "Leg / Push / Pull / Rest or Active Recovery";

test("version 2 keeps routine slots while version 1 remains compatible", () => {
  const legacy = normaliseTrainingCycleConfig({
    version: 1,
    phases: [{ id: "full-body", label: "Full body", kind: "training" }],
  });
  const configured = normaliseTrainingCycleConfig({
    version: 2,
    phases: [
      {
        id: "push",
        label: "Push",
        kind: "training",
        routine: [
          {
            id: "horizontal-press",
            label: "水平推",
            preferredExercise: "Barbell Bench Press",
            alternatives: ["Dumbbell Bench Press", "Machine Chest Press"],
            targetSets: 4,
            targetReps: "8-10",
            targetEffort: "RIR 2-3",
          },
        ],
      },
      { id: "rest", label: "Rest", kind: "recovery", routine: [] },
    ],
  });

  assert.equal(legacy.version, 1);
  assert.equal(configured.version, 2);
  assert.equal(configured.phases[0].routine[0].label, "水平推");
  assert.equal(parseCycle("unused", configured)[0].routine[0].targetSets, 4);
});

test("structured cycle semantics come from stable kind, never the displayed label", () => {
  const phases = parseCycle("unused", {
    version: 2,
    phases: [
      { id: "push-label", label: "Push", kind: "training", routine: [] },
      { id: "rest-label", label: "Rest lab", kind: "training", routine: [] },
      { id: "leg-label", label: "Leg", kind: "recovery", routine: [] },
    ],
  });

  assert.deepEqual(
    phases.map((phase) => [phase.id, phase.category]),
    [
      ["push-label", "training"],
      ["rest-label", "training"],
      ["leg-label", "recovery"],
    ],
  );
});

test("structured cycles never advance from legacy recovery prose", () => {
  const next = inferNextCyclePhase({
    trainingCycle: "unused",
    trainingCycleConfig: {
      version: 1,
      phases: [
        { id: "a", label: "A", kind: "training" },
        { id: "pause", label: "Pause", kind: "recovery" },
        { id: "b", label: "B", kind: "training" },
      ],
    },
    latestCompletedTitle: "A",
    latestCompletedPhaseId: "a",
    latestCompletedSessionType: "Strength",
    latestCompletedDate: "2026-08-04",
    completionNotes: [
      {
        noteId: "legacy-future-note",
        noteDate: "2026-08-05",
        noteType: "Cycle phase completed",
        exerciseOrArea: "Rest",
        note: "Recovery completed",
      },
    ],
    planningDate: "2026-08-04",
  });

  assert.equal(next.id, "pause");
});

test("training adjustment is typed and independent from displayed wording", () => {
  assert.equal(
    trainingAdjustmentFor({
      phaseKind: "training",
      pain010: 4,
      recoveryAgeDays: 0,
    }),
    "recover",
  );
  assert.equal(
    trainingAdjustmentFor({
      phaseKind: "training",
      pain010: 2,
      recoveryAgeDays: 3,
    }),
    "reduce",
  );
  for (const input of [
    { phaseKind: "training", pain010: 1, recoveryAgeDays: 0 },
    { phaseKind: "training", pain010: null, recoveryAgeDays: 0 },
    { phaseKind: "training", pain010: 5, recoveryAgeDays: 4 },
    { phaseKind: "training", pain010: 5, recoveryAgeDays: -1 },
    { phaseKind: "recovery", pain010: 5, recoveryAgeDays: 0 },
  ]) {
    assert.equal(trainingAdjustmentFor(input), "normal");
  }
});

test("routine validation rejects duplicate exercises and recovery routines", () => {
  assert.throws(
    () =>
      normaliseTrainingCycleConfig({
        version: 2,
        phases: [
          {
            id: "push",
            label: "Push",
            kind: "training",
            routine: [
              {
                id: "press",
                label: "Press",
                preferredExercise: "Bench Press",
                alternatives: [" bench press "],
              },
            ],
          },
        ],
      }),
    /alternatives must be unique/,
  );
  assert.throws(
    () =>
      normaliseTrainingCycleConfig({
        version: 2,
        phases: [
          { id: "train", label: "Train", kind: "training" },
          {
            id: "rest",
            label: "Rest",
            kind: "recovery",
            routine: [
              {
                id: "walk",
                label: "Walk",
                preferredExercise: "Walk",
                alternatives: [],
              },
            ],
          },
        ],
      }),
    /only allowed on a training day/,
  );
});

function note({
  id,
  date,
  type = "Explicit non-event",
  area = null,
  text,
}) {
  return {
    noteId: id,
    noteDate: date,
    noteType: type,
    exerciseOrArea: area,
    note: text,
  };
}

test("completed rest day after Pull advances the next session to Leg", () => {
  const next = inferNextCyclePhase({
    trainingCycle: cycle,
    latestStrengthTitle: "Pull Day",
    latestStrengthDate: "2026-07-31",
    planningDate: "2026-08-02",
    completionNotes: [
      note({
        id: "REST-20260801",
        date: "2026-08-01",
        text: "休息日；沒有完成健身訓練。",
      }),
    ],
  });

  assert.equal(next.category, "leg");
  assert.equal(next.raw, "Leg");
});

test("Pull shows Recovery for the next Hong Kong calendar day", () => {
  const next = inferNextCyclePhase({
    trainingCycle: cycle,
    latestStrengthTitle: "Pull Day",
    latestStrengthDate: "2026-08-04",
    planningDate: "2026-08-05",
    completionNotes: [],
  });

  assert.equal(next.category, "recovery");
});

test("Recovery rolls to Leg after one full active calendar day", () => {
  const next = inferNextCyclePhase({
    trainingCycle: cycle,
    latestStrengthTitle: "Pull Day",
    latestStrengthDate: "2026-08-04",
    planningDate: "2026-08-06",
    completionNotes: [],
  });

  assert.equal(next.category, "leg");
});

test("a long idle gap consumes only Recovery and never skips Leg", () => {
  const next = inferNextCyclePhase({
    trainingCycle: cycle,
    latestStrengthTitle: "Pull Day",
    latestStrengthDate: "2026-08-04",
    planningDate: "2026-08-10",
    completionNotes: [],
  });

  assert.equal(next.category, "leg");
});

test("paused calendar days freeze automatic Recovery rollover", () => {
  const pausedIntervals = [
    {
      eventId: "pause-1",
      startsOn: "2026-08-05",
      resumeOn: "2026-08-10",
      reason: null,
    },
  ];
  const resumeDay = inferNextCyclePhase({
    trainingCycle: cycle,
    latestStrengthTitle: "Pull Day",
    latestStrengthDate: "2026-08-04",
    planningDate: "2026-08-10",
    pausedIntervals,
    completionNotes: [],
  });
  const followingDay = inferNextCyclePhase({
    trainingCycle: cycle,
    latestStrengthTitle: "Pull Day",
    latestStrengthDate: "2026-08-04",
    planningDate: "2026-08-11",
    pausedIntervals,
    completionNotes: [],
  });

  assert.equal(resumeDay.category, "recovery");
  assert.equal(followingDay.category, "leg");
});

test("an extra rest day does not skip an expected strength phase", () => {
  const next = inferNextCyclePhase({
    trainingCycle: cycle,
    latestStrengthTitle: "Push Day",
    latestStrengthDate: "2026-07-30",
    planningDate: "2026-08-01",
    completionNotes: [
      note({
        id: "REST-20260731",
        date: "2026-07-31",
        text: "休息日；沒有完成健身訓練。",
      }),
    ],
  });

  assert.equal(next.category, "pull");
});

test("cardio non-event is not treated as a completed recovery phase", () => {
  const completion = cycleCompletionEvidence([
    note({
      id: "NO-CARDIO-20260729",
      date: "2026-07-29",
      type: "Explicit non-event",
      area: "Cardio",
      text: "未做帶氧。",
    }),
  ]);

  assert.deepEqual(completion, []);
});

test("same-day date-only rest note cannot advance a workout ambiguously", () => {
  const next = inferNextCyclePhase({
    trainingCycle: cycle,
    latestStrengthTitle: "Pull Day",
    latestStrengthDate: "2026-07-31",
    planningDate: "2026-08-01",
    completionNotes: [
      note({
        id: "REST-20260731",
        date: "2026-07-31",
        text: "休息日。",
      }),
    ],
  });

  assert.equal(next.category, "recovery");
});

test("a structured strength note cannot advance the cycle", () => {
  const next = inferNextCyclePhase({
    trainingCycle: cycle,
    latestStrengthTitle: "Leg Day",
    latestStrengthDate: "2026-08-01",
    planningDate: "2026-08-03",
    completionNotes: [
      note({
        id: "NOTE-PUSH-20260802",
        date: "2026-08-02",
        type: "Cycle phase completed",
        area: "Push",
        text: "Push completed",
      }),
    ],
  });

  assert.equal(next.category, "push");
});

test("custom configured phases match their raw identity before category fallback", () => {
  const next = inferNextCyclePhase({
    trainingCycle: "Upper A / Lower / Upper B / Rest",
    latestStrengthTitle: "Upper B Day",
    latestStrengthDate: "2026-08-04",
    planningDate: "2026-08-05",
    completionNotes: [],
  });

  assert.equal(next.raw, "Rest");
  assert.equal(next.kind, "recovery");
});

test("structured custom phases advance by stable id after their label changes", () => {
  const next = inferNextCyclePhase({
    trainingCycle: "Legacy value is only a fallback",
    trainingCycleConfig: JSON.stringify({
      version: 1,
      phases: [
        { id: "day-a", label: "Full body technique", kind: "training" },
        { id: "day-b", label: "Power and carries", kind: "training" },
        { id: "reset", label: "Reset", kind: "recovery" },
      ],
    }),
    latestStrengthTitle: "The old name no longer matches",
    latestStrengthPhaseId: "day-a",
    latestStrengthDate: "2026-08-04",
    planningDate: "2026-08-05",
    completionNotes: [],
  });

  assert.equal(next.id, "day-b");
  assert.equal(next.raw, "Power and carries");
  assert.equal(next.category, "training");
});

test("configured Cardio and Mobility workouts advance without Strength semantics", () => {
  const trainingCycleConfig = {
    version: 1,
    phases: [
      { id: "cardio", label: "Zone 2 Cardio", kind: "training" },
      { id: "mobility", label: "Mobility Flow", kind: "training" },
      { id: "sport", label: "Court Session", kind: "training" },
    ],
  };
  const phases = parseCycle("unused", trainingCycleConfig);

  assert.equal(
    matchedCompletedTrainingPhase({
      phases,
      sessionTitle: "Imported cardio workout",
      sessionType: "Cardio",
      trainingPhaseId: "cardio",
    })?.id,
    "cardio",
  );
  assert.equal(
    inferNextCyclePhase({
      trainingCycle: "unused",
      trainingCycleConfig,
      latestCompletedTitle: "Imported cardio workout",
      latestCompletedPhaseId: "cardio",
      latestCompletedSessionType: "Cardio",
      latestCompletedDate: "2026-08-04",
      planningDate: "2026-08-05",
      completionNotes: [],
    })?.id,
    "mobility",
  );
  assert.equal(
    inferNextCyclePhase({
      trainingCycle: "unused",
      trainingCycleConfig,
      latestCompletedTitle: "Mobility Flow",
      latestCompletedSessionType: "Mobility",
      latestCompletedDate: "2026-08-05",
      planningDate: "2026-08-06",
      completionNotes: [],
    })?.id,
    "sport",
  );
  assert.equal(
    matchedCompletedTrainingPhase({
      phases,
      sessionTitle: "Unconfigured easy cardio",
      sessionType: "Cardio",
    }),
    null,
  );
});

test("an unassigned Cardio title cannot advance a legacy PPL category", () => {
  const phases = parseCycle("Leg / Push / Pull / Rest");

  assert.equal(
    matchedCompletedTrainingPhase({
      phases,
      sessionTitle: "Leg Recovery Cardio",
      sessionType: "Cardio",
    }),
    null,
  );
});

test("consecutive recovery phases consume one active calendar day each", () => {
  const trainingCycleConfig = {
    version: 1,
    phases: [
      { id: "lift-a", label: "Lift A", kind: "training" },
      { id: "reset", label: "Reset", kind: "recovery" },
      { id: "easy", label: "Easy day", kind: "recovery" },
      { id: "lift-b", label: "Lift B", kind: "training" },
    ],
  };
  const nextOn = (planningDate, pausedIntervals = []) =>
    inferNextCyclePhase({
      trainingCycle: "unused",
      trainingCycleConfig,
      latestCompletedTitle: "Lift A",
      latestCompletedPhaseId: "lift-a",
      latestCompletedDate: "2026-08-01",
      planningDate,
      pausedIntervals,
      completionNotes: [],
    });

  assert.equal(nextOn("2026-08-02")?.id, "reset");
  assert.equal(nextOn("2026-08-03")?.id, "easy");
  assert.equal(nextOn("2026-08-04")?.id, "lift-b");

  const pausedIntervals = [
    {
      eventId: "trip",
      startsOn: "2026-08-02",
      resumeOn: "2026-08-04",
      reason: "Travel",
    },
  ];
  assert.equal(nextOn("2026-08-04", pausedIntervals)?.id, "reset");
  assert.equal(nextOn("2026-08-05", pausedIntervals)?.id, "easy");
  assert.equal(nextOn("2026-08-06", pausedIntervals)?.id, "lift-b");
});

test("an obsolete explicit phase id is never reinterpreted from its old title", () => {
  const next = inferNextCyclePhase({
    trainingCycle: "unused",
    trainingCycleConfig: {
      version: 1,
      phases: [
        { id: "upper", label: "Upper", kind: "training" },
        { id: "lower", label: "Lower", kind: "training" },
      ],
    },
    latestStrengthTitle: "Upper Day",
    latestStrengthPhaseId: "retired-upper",
    latestStrengthDate: "2026-08-04",
    planningDate: "2026-08-05",
    completionNotes: [],
  });

  assert.equal(next.id, "upper");
});

test("custom training phases compare by id or label without collapsing together", () => {
  const phases = parseCycle("unused", {
    version: 1,
    phases: [
      { id: "upper-a", label: "Upper A", kind: "training" },
      { id: "upper-b", label: "Upper B", kind: "training" },
    ],
  });

  assert.equal(
    sessionMatchesCyclePhase({
      phase: phases[0],
      sessionTitle: "Renamed session",
      trainingPhaseId: "upper-a",
    }),
    true,
  );
  assert.equal(
    sessionMatchesCyclePhase({
      phase: phases[1],
      sessionTitle: "Upper A Day",
    }),
    false,
  );
  assert.equal(
    sessionMatchesCyclePhase({
      phase: phases[0],
      sessionTitle: "Upper A Day",
    }),
    true,
  );
  assert.equal(inferSessionTrainingPhaseId(phases, "Upper B Day"), "upper-b");
  assert.equal(inferSessionTrainingPhaseId(phases, "Unrelated workout"), null);
});

test("legacy PPL category inference only stores a phase id when unambiguous", () => {
  const onePush = parseCycle("Push / Pull / Rest");
  const twoPushes = parseCycle("Push A / Push B / Pull / Rest");

  assert.equal(inferSessionTrainingPhaseId(onePush, "Push Day"), "legacy-phase-1");
  assert.equal(inferSessionTrainingPhaseId(twoPushes, "Push Day"), null);
  assert.equal(
    inferSessionTrainingPhaseId(onePush, "Push Cardio", "Cardio"),
    null,
  );
  assert.equal(
    inferSessionTrainingPhaseId(onePush, "Push", "Cardio"),
    "legacy-phase-1",
  );
});

test("an unconfigured cycle does not invent a Leg phase", () => {
  const next = inferNextCyclePhase({
    trainingCycle: "",
    latestStrengthTitle: undefined,
    latestStrengthDate: undefined,
    planningDate: "2026-08-05",
    completionNotes: [],
  });

  assert.equal(next, null);
});
