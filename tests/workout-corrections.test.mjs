import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { projectWorkoutCorrections } from "../lib/workout-correction-projection.mjs";
import { inferNextCyclePhase } from "../lib/training-cycle.ts";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("projection applies latest correction, breaks ties, and preserves source rows", () => {
  const sourceSession = { sessionId: "SESSION|1", sessionTitle: "A" };
  const sourceSet = { setId: "SET|1", exercise: "Raw exercise" };
  const history = [
    {
      correctionId: "CORRECTION|B",
      targetScope: "workout_session",
      targetKey: sourceSession.sessionId,
      fieldName: "session_title",
      correctedValue: "B",
      recordedAt: "2026-08-10T01:00:00.000Z",
    },
    {
      correctionId: "CORRECTION|C",
      targetScope: "workout_session",
      targetKey: sourceSession.sessionId,
      fieldName: "session_title",
      correctedValue: "C",
      recordedAt: "2026-08-10T02:00:00.000Z",
    },
  ];

  const latest = projectWorkoutCorrections(
    { sessions: [sourceSession], sets: [sourceSet] },
    history,
  );
  assert.equal(latest.sessions[0].sessionTitle, "C");
  assert.equal(latest.appliedCorrections[0].correctionId, "CORRECTION|C");

  const tied = projectWorkoutCorrections(
    { sessions: [sourceSession], sets: [sourceSet] },
    [
      ...history,
      {
        ...history[1],
        correctionId: "CORRECTION|D",
        correctedValue: "tie winner",
      },
      {
        correctionId: "CORRECTION|SET",
        targetScope: "workout_set",
        targetKey: sourceSet.setId,
        fieldName: "exercise",
        correctedValue: "Effective exercise",
        recordedAt: "2026-08-10T03:00:00.000Z",
      },
    ],
  );
  assert.equal(tied.sessions[0].sessionTitle, "tie winner");
  assert.equal(tied.sets[0].exercise, "Effective exercise");
  assert.deepEqual(sourceSession, { sessionId: "SESSION|1", sessionTitle: "A" });
  assert.deepEqual(sourceSet, { setId: "SET|1", exercise: "Raw exercise" });
});

test("projection applies typed workout corrections and recomputes reported load", () => {
  const sourceSession = {
    sessionId: "SESSION|LEG",
    sessionTitle: "Localized leg session",
    trainingPhaseId: null,
    totalTvlKgReported: 540,
  };
  const sourceSet = {
    setId: "SET|RDL|3",
    sessionId: sourceSession.sessionId,
    exercise: "Romanian deadlift",
    reps: 9,
    weightKgReported: 60,
    effortRaw: "RPE 8",
    reportedLoadXRepsKg: 540,
  };
  const untouchedSet = {
    setId: "SET|RDL|4",
    sessionId: sourceSession.sessionId,
    exercise: "Romanian deadlift",
    reps: 10,
    weightKgReported: 40,
    effortRaw: "RPE 6",
    reportedLoadXRepsKg: 400,
  };
  const projected = projectWorkoutCorrections(
    { sessions: [sourceSession], sets: [sourceSet, untouchedSet] },
    [
      {
        correctionId: "CORRECTION|PHASE",
        targetScope: "workout_session",
        targetKey: sourceSession.sessionId,
        fieldName: "training_phase_id",
        correctedValue: "leg",
        recordedAt: "2026-08-11T01:00:00.000Z",
      },
      {
        correctionId: "CORRECTION|REPS",
        targetScope: "workout_set",
        targetKey: sourceSet.setId,
        fieldName: "reps",
        correctedValue: "8",
        recordedAt: "2026-08-11T01:01:00.000Z",
      },
      {
        correctionId: "CORRECTION|WEIGHT",
        targetScope: "workout_set",
        targetKey: sourceSet.setId,
        fieldName: "weight_kg_reported",
        correctedValue: "62.5",
        recordedAt: "2026-08-11T01:02:00.000Z",
      },
      {
        correctionId: "CORRECTION|EFFORT",
        targetScope: "workout_set",
        targetKey: sourceSet.setId,
        fieldName: "effort_raw",
        correctedValue: "RPE 7",
        recordedAt: "2026-08-11T01:03:00.000Z",
      },
    ],
  );

  assert.equal(projected.sessions[0].trainingPhaseId, "leg");
  assert.equal(projected.sessions[0].totalTvlKgReported, 900);
  assert.equal(projected.sets[0].reps, 8);
  assert.equal(projected.sets[0].weightKgReported, 62.5);
  assert.equal(projected.sets[0].effortRaw, "RPE 7");
  assert.equal(projected.sets[0].reportedLoadXRepsKg, 500);
  assert.equal(projected.appliedCorrections.length, 4);
  assert.equal(sourceSession.trainingPhaseId, null);
  assert.equal(sourceSet.reps, 9);
  assert.equal(sourceSet.weightKgReported, 60);
  assert.equal(sourceSet.effortRaw, "RPE 8");
  assert.equal(sourceSet.reportedLoadXRepsKg, 540);
  assert.equal(projected.sets[1].reportedLoadXRepsKg, 400);
  assert.equal(untouchedSet.reportedLoadXRepsKg, 400);
});

test("nullable workout corrections intentionally clear effective values", () => {
  const sourceSet = {
    setId: "SET|OPTIONAL",
    exercise: "Bench press",
    reps: 8,
    weightKgReported: 40,
    effortRaw: "RPE 7",
    reportedLoadXRepsKg: 320,
  };
  const projected = projectWorkoutCorrections(
    { sets: [sourceSet] },
    [
      {
        correctionId: "CORRECTION|NULL-REPS",
        targetScope: "workout_set",
        targetKey: sourceSet.setId,
        fieldName: "reps",
        correctedValue: null,
        recordedAt: "2026-08-11T02:00:00.000Z",
      },
      {
        correctionId: "CORRECTION|NULL-EFFORT",
        targetScope: "workout_set",
        targetKey: sourceSet.setId,
        fieldName: "effort_raw",
        correctedValue: null,
        recordedAt: "2026-08-11T02:01:00.000Z",
      },
    ],
  );
  assert.equal(projected.sets[0].reps, null);
  assert.equal(projected.sets[0].effortRaw, null);
  assert.equal(projected.sets[0].reportedLoadXRepsKg, 0);
  assert.equal(projected.appliedCorrections.length, 2);
  assert.equal(sourceSet.reps, 8);
  assert.equal(sourceSet.effortRaw, "RPE 7");
});

test("malformed stored numeric corrections are ignored without changing raw values", () => {
  const sourceSet = {
    setId: "SET|MALFORMED",
    exercise: "Squat",
    reps: 8,
    weightKgReported: 50,
    reportedLoadXRepsKg: 400,
  };
  const rangeSet = { ...sourceSet, setId: "SET|MALFORMED-RANGE" };
  const fractionSet = { ...sourceSet, setId: "SET|MALFORMED-FRACTION" };
  const projected = projectWorkoutCorrections(
    { sets: [sourceSet, rangeSet, fractionSet] },
    [
      {
        correctionId: "CORRECTION|BLANK-REPS",
        targetScope: "workout_set",
        targetKey: sourceSet.setId,
        fieldName: "reps",
        correctedValue: "   ",
        recordedAt: "2026-08-11T03:00:00.000Z",
      },
      {
        correctionId: "CORRECTION|NEGATIVE-WEIGHT",
        targetScope: "workout_set",
        targetKey: sourceSet.setId,
        fieldName: "weight_kg_reported",
        correctedValue: "-1",
        recordedAt: "2026-08-11T03:01:00.000Z",
      },
      {
        correctionId: "CORRECTION|RANGE-REPS",
        targetScope: "workout_set",
        targetKey: rangeSet.setId,
        fieldName: "reps",
        correctedValue: "1001",
        recordedAt: "2026-08-11T03:02:00.000Z",
      },
      {
        correctionId: "CORRECTION|FRACTION-REPS",
        targetScope: "workout_set",
        targetKey: fractionSet.setId,
        fieldName: "reps",
        correctedValue: "1.5",
        recordedAt: "2026-08-11T03:03:00.000Z",
      },
    ],
  );
  assert.equal(projected.sets[0].reps, 8);
  assert.equal(projected.sets[0].weightKgReported, 50);
  assert.equal(projected.sets[0].reportedLoadXRepsKg, 400);
  assert.equal(projected.sets[1].reps, 8);
  assert.equal(projected.sets[2].reps, 8);
  assert.deepEqual(projected.appliedCorrections, []);
  assert.deepEqual(sourceSet, {
    setId: "SET|MALFORMED",
    exercise: "Squat",
    reps: 8,
    weightKgReported: 50,
    reportedLoadXRepsKg: 400,
  });
  assert.equal(projected.appliedCorrections.length, 0);
});

test("malformed stored text corrections are ignored without detaching effective values", () => {
  const sourceSession = {
    sessionId: "SESSION|TEXT-MALFORMED",
    sessionTitle: "Leg day",
    trainingPhaseId: "leg",
  };
  const sourceSet = {
    setId: "SET|TEXT-MALFORMED",
    sessionId: sourceSession.sessionId,
    exercise: "Squat",
    effortRaw: "RPE 8",
  };
  const projected = projectWorkoutCorrections(
    { sessions: [sourceSession], sets: [sourceSet] },
    [
      {
        correctionId: "CORRECTION|BLANK-PHASE",
        targetScope: "workout_session",
        targetKey: sourceSession.sessionId,
        fieldName: "training_phase_id",
        correctedValue: "   ",
        recordedAt: "2026-08-11T03:10:00.000Z",
      },
      {
        correctionId: "CORRECTION|BLANK-EFFORT",
        targetScope: "workout_set",
        targetKey: sourceSet.setId,
        fieldName: "effort_raw",
        correctedValue: "  ",
        recordedAt: "2026-08-11T03:11:00.000Z",
      },
    ],
  );
  assert.equal(projected.sessions[0].trainingPhaseId, "leg");
  assert.equal(projected.sets[0].effortRaw, "RPE 8");
  assert.deepEqual(projected.appliedCorrections, []);
  assert.equal(sourceSession.trainingPhaseId, "leg");
  assert.equal(sourceSet.effortRaw, "RPE 8");
});

test("projection orders correction instants across offsets and falls back deterministically", () => {
  const sourceSession = {
    sessionId: "SESSION|ORDERING",
    sessionTitle: "Raw title",
  };
  const offsetProjected = projectWorkoutCorrections(
    { sessions: [sourceSession] },
    [
      {
        correctionId: "CORRECTION|OFFSET",
        targetScope: "workout_session",
        targetKey: sourceSession.sessionId,
        fieldName: "session_title",
        correctedValue: "Offset title",
        recordedAt: "2026-08-11T10:00:00+08:00",
      },
      {
        correctionId: "CORRECTION|Z",
        targetScope: "workout_session",
        targetKey: sourceSession.sessionId,
        fieldName: "session_title",
        correctedValue: "Z title",
        recordedAt: "2026-08-11T01:30:00Z",
      },
    ],
  );
  assert.equal(offsetProjected.sessions[0].sessionTitle, "Offset title");

  const malformedProjected = projectWorkoutCorrections(
    { sessions: [sourceSession] },
    [
      {
        correctionId: "CORRECTION|MALFORMED-A",
        targetScope: "workout_session",
        targetKey: sourceSession.sessionId,
        fieldName: "session_title",
        correctedValue: "A title",
        recordedAt: "legacy-time",
      },
      {
        correctionId: "CORRECTION|MALFORMED-B",
        targetScope: "workout_session",
        targetKey: sourceSession.sessionId,
        fieldName: "session_title",
        correctedValue: "B title",
        recordedAt: "legacy-time",
      },
    ],
  );
  assert.equal(malformedProjected.sessions[0].sessionTitle, "B title");
});

test("stable phase correction advances a backdated workout while a localized title does not", () => {
  const trainingCycleConfig = {
    version: 2,
    phases: [
      { id: "leg", label: "Leg", kind: "training", routine: [] },
      { id: "push", label: "Push", kind: "training", routine: [] },
      { id: "pull", label: "Pull", kind: "training", routine: [] },
    ],
  };
  const nextWithoutAssociation = inferNextCyclePhase({
    trainingCycle: "unused",
    trainingCycleConfig,
    latestCompletedTitle: "腿日",
    latestCompletedPhaseId: null,
    latestCompletedDate: "2026-08-10",
    latestCompletedSessionType: "Strength",
    completionNotes: [],
    planningDate: "2026-08-11",
  });
  assert.equal(nextWithoutAssociation?.id, "leg");

  const nextWithAssociation = inferNextCyclePhase({
    trainingCycle: "unused",
    trainingCycleConfig,
    latestCompletedTitle: "腿日",
    latestCompletedPhaseId: "leg",
    latestCompletedDate: "2026-08-10",
    latestCompletedSessionType: "Strength",
    completionNotes: [],
    planningDate: "2026-08-11",
  });
  assert.equal(nextWithAssociation?.id, "push");
});

test("voided exact reads retain effective names and correction provenance", () => {
  const sourceSession = {
    sessionId: "SESSION|VOIDED",
    sessionTitle: "Raw title",
    voidedAt: "2026-08-10T04:00:00.000Z",
  };
  const correction = {
    correctionId: "CORRECTION|VOIDED",
    targetScope: "workout_session",
    targetKey: sourceSession.sessionId,
    fieldName: "session_title",
    correctedValue: "Effective title",
    recordedAt: "2026-08-10T03:00:00.000Z",
  };
  const projected = projectWorkoutCorrections(
    { sessions: [sourceSession] },
    [correction],
  );

  assert.equal(projected.sessions[0].sessionTitle, "Effective title");
  assert.equal(projected.sessions[0].voidedAt, sourceSession.voidedAt);
  assert.deepEqual(projected.appliedCorrections, [correction]);

  const route = source("app/api/fitness/workout-sessions/route.ts");
  const get = route.slice(route.indexOf("export async function GET"));
  assert.match(get, /const projected = await effectiveWorkoutRecords/);
  assert.doesNotMatch(get, /session\.voidedAt\s*\?/);
});

test("configured strength progress follows raw identity through a correction", () => {
  const fitness = source("lib/fitness.ts");

  assert.match(fitness, /weightKgReported: workoutSets\.weightKgReported/);
  assert.match(fitness, /weightKg: set\.weightKgReported/);
  assert.match(fitness, /reportedLoadXRepsKg: workoutSets\.reportedLoadXRepsKg/);
  assert.match(fitness, /rawExercise\?: string/);
  assert.match(
    fitness,
    /canonicalExerciseIdentity\(row\.rawExercise\)/,
  );
  assert.match(
    fitness,
    /rawExerciseBySetId = new Map\([\s\S]*?rawStrengthSetRows\.map/,
  );
  assert.match(
    fitness,
    /progressExerciseIdentities[\s\S]*?currentProfile\?\.strengthProgressExercise[\s\S]*?row\.rawExercise/,
  );
});

test("configured routine history follows a corrected exercise identity", () => {
  const fitness = source("lib/fitness.ts");

  assert.match(
    fitness,
    /type SetRow = typeof workoutSets\.\$inferSelect & \{ rawExercise\?: string \}/,
  );
  assert.match(
    fitness,
    /withRawExercise[\s\S]*?rawExercise: set\.exercise[\s\S]*?rawComparableSets\.map\(withRawExercise\)/,
  );
  assert.match(
    fitness,
    /const exerciseSets = sets\.filter\(\(set\) =>[\s\S]*?setMatchesExercise\(set, selection\.exercise\)/,
  );
  assert.match(
    fitness,
    /function setMatchesExercise[\s\S]*?setExerciseNames\(set\)/,
  );
});

test("unconfigured planning matches English constraints after a Chinese rename", () => {
  const fitness = source("lib/fitness.ts");
  const course = fitness.slice(
    fitness.indexOf("function buildHistoryCourseItems"),
    fitness.indexOf("function buildConfiguredCourseItems"),
  );

  assert.match(
    course,
    /exerciseConstraintStateForSets\([\s\S]*?semanticSets,[\s\S]*?constraints/,
  );
  assert.match(
    fitness,
    /exerciseConstraintStateForSets[\s\S]*?sets\.flatMap\(\(set\) => \[set\.exercise, set\.rawExercise \?\? set\.exercise\]\)/,
  );
  assert.match(fitness, /effectiveOperatingConstraints/);
  assert.doesNotMatch(
    course,
    /\.filter\([\s\S]*?exerciseConstraintStateForSets[\s\S]*?\.paused/,
  );
});

test("planning and review semantics retain the raw English exercise name", () => {
  const fitness = source("lib/fitness.ts");
  const course = fitness.slice(
    fitness.indexOf("function displayLoadText"),
    fitness.indexOf("function buildConfiguredCourseItems"),
  );
  const review = fitness.slice(
    fitness.indexOf("function reviewExerciseLine"),
    fitness.indexOf("function buildSessionReview"),
  );

  assert.match(
    fitness,
    /function exerciseSemanticText[\s\S]*?sets\.flatMap\(setExerciseNames\)/,
  );
  assert.match(course, /isCompoundExercise\(exercise, semanticSets\)/);
  assert.match(
    course,
    /machine\|cable[\s\S]*?exerciseSemanticText\(exercise, semanticSets\)/,
  );
  assert.match(
    course,
    /displayLoadText\(exercise, workingWeight, semanticSets\)/,
  );
  assert.match(
    review,
    /exerciseSemanticText\(exercise, exerciseRows\)[\s\S]*?bodyweight[\s\S]*?dumbbell/,
  );
});

test("prior-session comparison shares raw and effective exercise identity", () => {
  const fitness = source("lib/fitness.ts");
  const comparison = fitness.slice(
    fitness.indexOf("function comparableExerciseLine"),
    fitness.indexOf("function buildSessionReview"),
  );

  assert.match(
    fitness,
    /function setsShareExercise[\s\S]*?setExerciseNames\(left\)[\s\S]*?setMatchesExercise\(right, exercise\)/,
  );
  assert.match(
    comparison,
    /previousRows\.some\(\(previous\) => setsShareExercise\(current, previous\)\)/,
  );
  assert.match(
    comparison,
    /const exercise = sharedExercise\.exercise[\s\S]*?exerciseSemanticText\(exercise, \[/,
  );
  assert.match(
    comparison,
    /bodyweight\|pull-up[\s\S]*?dumbbell\|single-arm[\s\S]*?dumbbell\|single-arm/,
  );
});

test("workout names use one append-only effective-value projection", () => {
  const projection = source("lib/workout-corrections.ts");
  assert.match(projection, /workout_session: "session_title"/);
  assert.match(projection, /workout_set: "exercise"/);
  assert.match(
    projection,
    /orderBy\(desc\(corrections\.recordedAt\), desc\(corrections\.correctionId\)\)/,
  );
  assert.doesNotMatch(projection, /update\(workoutSessions|update\(workoutSets/);

  for (const path of [
    "app/api/fitness/workout-sessions/route.ts",
    "app/api/fitness/log/route.ts",
    "app/api/fitness/analysis/route.ts",
    "app/api/fitness/profile/route.ts",
    "lib/fitness.ts",
  ]) {
    assert.match(source(path), /effectiveWorkoutRecords/);
  }

  const exactWorkout = source("app/api/fitness/workout-sessions/route.ts");
  assert.match(exactWorkout, /appliedCorrections: projected\.appliedCorrections/);

  const analysis = source("app/api/fitness/analysis/route.ts");
  assert.ok(
    analysis.indexOf("const projectedWorkout = await effectiveWorkoutRecords") <
      analysis.indexOf("const allSetRows = exercise"),
  );
  assert.match(analysis, /like\(workoutSets\.exercise, `%\$\{exercise\}%`\)/);
  assert.match(analysis, /isNull\(workoutSessions\.voidedAt\)/);
});

test("correction replay wins before optimistic validation", () => {
  const route = source("app/api/fitness/corrections/route.ts");
  const post = route.slice(route.indexOf("export async function POST"));
  const transaction = post.indexOf("db.transaction");
  const replay = post.indexOf("if (replayedId)", transaction);
  const targetRead = post.indexOf("const targetState", replay);
  assert.ok(transaction >= 0 && replay > transaction && targetRead > replay);
  assert.match(post, /WORKOUT_CORRECTION_ORIGINAL_REQUIRED/);
  assert.match(post, /typeof payload\.originalValue !== "string"/);
  assert.match(post, /originalValue: targetState[\s\S]*targetState\.effectiveValue/);
  assert.match(post, /WORKOUT_CORRECTION_STALE_ORIGINAL/);
  assert.match(post, /WORKOUT_CORRECTION_TARGET_NOT_FOUND/);
  assert.match(post, /WORKOUT_CORRECTION_TARGET_VOIDED/);
  assert.match(post, /WORKOUT_CORRECTION_VALUE_REQUIRED/);
  assert.match(post, /UNSUPPORTED_WORKOUT_CORRECTION_FIELD/);
  assert.match(post, /: payload\.correctedValue \?\? null/);
  assert.match(post, /generatedIdDigest/);
  assert.match(post, /findIdempotentReplay\([\s\S]*digest,[\s\S]*tx/);
  assert.doesNotMatch(post, /\.update\(workout(?:Sessions|Sets)\)/);
  assert.match(post, /WORKOUT_CORRECTION_INVALID_PHASE/);
  assert.match(post, /WORKOUT_CORRECTION_TARGET_DATE_UNAVAILABLE/);
  assert.match(post, /WORKOUT_CORRECTION_DATE_MISMATCH/);
  assert.match(
    post,
    /"targetLocalDate" in targetState[\s\S]*!isDateOnly\(targetState\.targetLocalDate\)/,
  );
  assert.equal(
    (route.match(/localDate: workoutSessions\.localDate/g) ?? []).length,
    2,
  );
  assert.match(post, /UNKNOWN_CORRECTION_FIELD/);
  assert.match(post, /WORKOUT_CORRECTION_VALUE_OUT_OF_RANGE/);
  assert.match(post, /INVALID_CORRECTION_PAYLOAD/);
  assert.match(post, /WORKOUT_CORRECTION_RECORDED_AT_STALE/);
  assert.match(post, /currentRecordedAt/);
  assert.match(post, /const recordedAt = payload\.recordedAt/);
  assert.doesNotMatch(post, /hasProvidedRecordedAt/);
  assert.ok(post.indexOf("WORKOUT_CORRECTION_RECORDED_AT_STALE") > targetRead);
  assert.doesNotMatch(route, /value\.trim\(\)\.length > 240/);
  assert.match(post, /OPERATING_CONSTRAINT_CORRECTION_VALUES_REQUIRED/);
  assert.match(post, /INVALID_OPERATING_CONSTRAINT_STATUS/);
  assert.match(post, /operatingConstraintTargetState/);
  assert.match(
    route,
    /normaliseOperatingConstraintStatus\(projectedStatus\)[\s\S]*projectedStatus\.trim\(\)/,
  );
  assert.match(post, /OPERATING_CONSTRAINT_STALE_ORIGINAL/);
  assert.match(post, /OPERATING_CONSTRAINT_DATE_BEFORE_TARGET/);
  assert.doesNotMatch(post, /update\(operatingConstraints\)/);

  const analysis = source("app/api/fitness/analysis/route.ts");
  assert.match(
    analysis,
    /targetScope === "operating_constraint"[\s\S]*effectiveDate <= to/,
  );
  assert.match(analysis, /corrections: returnedCorrections/);
  assert.match(
    analysis,
    /view === "full"[\s\S]*targetScope !== "operating_constraint"/,
  );
});

test("agent contract defines exact workout correction identities and outcomes", () => {
  const contract = source("agent-plugin/skills/open-fitness/references/contract.md");
  assert.match(contract, /`fieldName: "session_title"`/);
  assert.match(contract, /`fieldName: "exercise"`/);
  assert.match(contract, /`fieldName: "training_phase_id"`/);
  assert.match(contract, /`fieldName: "weight_kg_reported"`/);
  assert.match(contract, /`fieldName: "effort_raw"`/);
  assert.match(contract, /changes only that set/);
  assert.match(contract, /send its current effective field value as `originalValue`/);
  assert.match(contract, /Require a\s+`succeeded` outcome/);
  assert.match(contract, /lean analysis view omits `setId`/);
  assert.match(contract, /`targetScope: "operating_constraint"`/);
  assert.match(contract, /`fieldName: "status"`/);
  assert.match(contract, /`Resolved`/);
  assert.match(contract, /explicit owner conclusion/);
});

test("phase corrections attach or reassign only", () => {
  const route = source("app/api/fitness/corrections/route.ts");
  assert.match(route, /spec\.kind === "phase" && role === "corrected"/);
  assert.match(route, /WORKOUT_CORRECTION_PHASE_DETACH_UNSUPPORTED/);
  assert.match(route, /if \(spec\.nullable\) return null/);
  assert.match(route, /payload\.originalValue[\s\S]*normaliseWorkoutCorrectionValue/);
  assert.match(route, /payload\.correctedValue[\s\S]*normaliseWorkoutCorrectionValue/);
  const contract = source("agent-plugin/skills/open-fitness/references/contract.md");
  assert.match(contract, /originalValue: null/);
  assert.match(contract, /rejects a null corrected value/);
});
