import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { evaluateTrainingProgression } from "../lib/training-progression.ts";

const phase = {
  id: "push",
  raw: "Push",
  kind: "training",
  category: "push",
  routine: [
    {
      id: "press",
      label: "Press",
      preferredExercise: "Machine Chest Press",
      alternatives: [],
      targetSets: 3,
      targetReps: "8-10",
      targetEffort: "RIR 2-3",
      loadIncrementKg: 2.5,
    },
  ],
};

function session(
  sessionId,
  startedAt,
  { block = "block-a", intent = "normal", pain = null } = {},
) {
  return {
    sessionId,
    trainingPhaseId: "push",
    trainingBlockId: block,
    sessionIntent: intent,
    startedAt,
    startedAtUtc: startedAt,
    venueManual: "Synthetic Gym",
    shoulderPainPre010Manual: pain,
    shoulderPainPost010Manual: null,
  };
}

function setsFor(
  sessionId,
  { reps = [10, 10, 10], effort = "RIR 2", weight = 50 } = {},
) {
  return reps.map((value, index) => ({
    sessionId,
    exercise: "Machine Chest Press",
    weightKgReported: weight,
    reps: value,
    effortRaw: effort,
    setTypeManual: "working",
    loadBasisManual: "machine stack",
    pain010Manual: null,
    venueManual: "Synthetic Gym",
    setNoSession: index + 1,
  }));
}

test("progression requires two consecutive qualified normal sessions", () => {
  const first = session("session-1", "2099-04-01T10:00:00.000Z");
  const second = session("session-2", "2099-04-08T10:00:00.000Z");
  const oneSession = evaluateTrainingProgression({
    phase,
    trainingBlockId: "block-a",
    sessions: [first],
    sets: setsFor(first.sessionId),
  });
  assert.equal(oneSession.proposals.length, 0);
  assert.equal(oneSession.blocked[0].reason, "insufficient_comparable_sessions");

  const twoSessions = evaluateTrainingProgression({
    phase,
    trainingBlockId: "block-a",
    sessions: [first, second],
    sets: [...setsFor(first.sessionId), ...setsFor(second.sessionId)],
  });
  assert.deepEqual(twoSessions.proposals, [
    {
      phaseId: "push",
      slotId: "press",
      exercise: "Machine Chest Press",
      sourceSessionIds: ["session-1", "session-2"],
      currentWeightKg: 50,
      suggestedWeightKg: 52.5,
      suggestedRangeKg: { minimum: 51, maximum: 55 },
      evidence: "rir",
    },
  ]);
});

test("legacy repetition fallback needs 1-2 extra last-set reps twice", () => {
  const sessions = [
    session("session-1", "2099-04-01T10:00:00.000Z"),
    session("session-2", "2099-04-08T10:00:00.000Z"),
  ];
  const result = evaluateTrainingProgression({
    phase,
    trainingBlockId: "block-a",
    sessions,
    sets: sessions.flatMap((row) =>
      setsFor(row.sessionId, { reps: [8, 10, 11], effort: null }),
    ),
  });
  assert.equal(result.proposals[0].evidence, "repetition_fallback");
});

test("unknown equipment increment returns a bounded range only", () => {
  const sessions = [
    session("session-1", "2099-04-01T10:00:00.000Z"),
    session("session-2", "2099-04-08T10:00:00.000Z"),
  ];
  const result = evaluateTrainingProgression({
    phase: {
      ...phase,
      routine: [{ ...phase.routine[0], loadIncrementKg: undefined }],
    },
    trainingBlockId: "block-a",
    sessions,
    sets: sessions.flatMap((row) => setsFor(row.sessionId)),
  });
  assert.equal(result.proposals[0].suggestedWeightKg, null);
  assert.deepEqual(result.proposals[0].suggestedRangeKg, {
    minimum: 51,
    maximum: 55,
  });
});

test("a deload advances history but never supplies progression evidence", () => {
  const sessions = [
    session("session-1", "2099-04-01T10:00:00.000Z"),
    session("session-2", "2099-04-08T10:00:00.000Z"),
    session("session-deload", "2099-04-15T10:00:00.000Z", {
      intent: "deload",
    }),
  ];
  const result = evaluateTrainingProgression({
    phase,
    trainingBlockId: "block-a",
    sessions,
    sets: sessions.flatMap((row) => setsFor(row.sessionId)),
  });
  assert.equal(result.proposals.length, 0);
  assert.equal(result.blocked[0].reason, "recent_non_normal_session");
});

test("a new training block never reuses the prior block as evidence", () => {
  const oldSessions = [
    session("old-1", "2099-04-01T10:00:00.000Z", { block: "block-old" }),
    session("old-2", "2099-04-08T10:00:00.000Z", { block: "block-old" }),
  ];
  const current = session("current-1", "2099-04-15T10:00:00.000Z", {
    block: "block-new",
  });
  const result = evaluateTrainingProgression({
    phase,
    trainingBlockId: "block-new",
    sessions: [...oldSessions, current],
    sets: [...oldSessions, current].flatMap((row) => setsFor(row.sessionId)),
  });
  assert.equal(result.proposals.length, 0);
  assert.equal(result.blocked[0].reason, "insufficient_comparable_sessions");
});

test("the progression endpoint evaluates the immutable active-block template", () => {
  const route = readFileSync(
    new URL("../app/api/fitness/training-progression/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    route,
    /parseCycle\(\s*currentProfile\.trainingCycle,\s*block\.trainingCycleSnapshot,\s*\)/,
  );
  assert.doesNotMatch(
    route,
    /parseCycle\(\s*currentProfile\.trainingCycle,\s*currentProfile\.trainingCycleConfig,\s*\)/,
  );
});

test("pain or an active exercise constraint blocks progression", () => {
  const sessions = [
    session("session-1", "2099-04-01T10:00:00.000Z"),
    session("session-2", "2099-04-08T10:00:00.000Z", { pain: 1 }),
  ];
  const result = evaluateTrainingProgression({
    phase,
    trainingBlockId: "block-a",
    sessions,
    sets: sessions.flatMap((row) => setsFor(row.sessionId)),
  });
  assert.equal(result.proposals.length, 0);
  assert.equal(result.blocked[0].reason, "pain_or_constraint");
});
