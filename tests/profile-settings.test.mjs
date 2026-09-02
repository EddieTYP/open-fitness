import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertStablePhaseKinds,
  classifyGoalType,
  inferTrainingPhaseBackfills,
  nextProfileUpdatedAt,
  normaliseProfilePatch,
  profileResponse,
  profileUpdateValues,
} from "../lib/profile-settings.ts";
import { APP_LOCALES } from "../lib/i18n/locales.ts";
import { parseCycle } from "../lib/training-cycle.ts";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const cycle = {
  version: 1,
  phases: [
    { id: "upper-a", label: "Upper A", kind: "training" },
    { id: "lower", label: "Lower", kind: "training" },
    { id: "recover", label: "Mobility", kind: "recovery" },
  ],
};

test("profile patch normalises generic settings and mirrors legacy fields", () => {
  const patch = normaliseProfilePatch({
    expectedUpdatedAt: "2026-08-07T00:00:00.000Z",
    displayName: "  Alex  ",
    goalType: "strength",
    trainingCycleConfig: cycle,
    strengthProgressExercise: "  Deadlift  ",
    heightCm: 178.5,
    preferredLocale: "en",
    setupCompleted: true,
  });
  assert.equal(patch.displayName, "Alex");
  assert.equal(patch.strengthProgressExercise, "Deadlift");
  assert.deepEqual(
    profileUpdateValues(patch, "2026-08-07T00:00:01.000Z"),
    {
      displayName: "Alex",
      goalType: "strength",
      trainingCycle: "Upper A / Lower / Mobility",
      trainingCycleConfig: JSON.stringify(cycle),
      strengthProgressExercise: "Deadlift",
      heightCm: 178.5,
      preferredLocale: "en",
      setupCompleted: true,
      updatedAt: "2026-08-07T00:00:01.000Z",
    },
  );
});

test("changing canonical goal type preserves the detailed primary goal", () => {
  const values = profileUpdateValues(
    normaliseProfilePatch({
      expectedUpdatedAt: "2026-08-07T00:00:00.000Z",
      goalType: "maintenance",
    }),
    "2026-08-07T00:00:01.000Z",
  );
  assert.deepEqual(values, {
    goalType: "maintenance",
    updatedAt: "2026-08-07T00:00:01.000Z",
  });
  assert.equal(Object.hasOwn(values, "primaryGoal"), false);
});

test("a persistent block start carries an explicit reason even when the goal is unchanged", () => {
  const patch = normaliseProfilePatch({
    expectedUpdatedAt: "2026-08-07T00:00:00.000Z",
    goalType: "fat_loss",
    trainingBlockChangeReason: "Owner confirmed a new progression block",
  });
  assert.equal(
    patch.trainingBlockChangeReason,
    "Owner confirmed a new progression block",
  );
  assert.deepEqual(
    profileUpdateValues(patch, "2026-08-07T00:00:01.000Z"),
    {
      goalType: "fat_loss",
      updatedAt: "2026-08-07T00:00:01.000Z",
    },
  );
});

test("profile patches accept one nested nutrition target for atomic setup", () => {
  assert.deepEqual(
    normaliseProfilePatch({
      expectedUpdatedAt: "revision",
      setupCompleted: true,
      nutritionTarget: {
        effectiveFrom: "2026-08-16",
        calorieTargetKcal: 2000,
        proteinTargetG: 150,
      },
    }).nutritionTarget,
    {
      effectiveFrom: "2026-08-16",
      calorieTargetKcal: 2000,
      proteinTargetG: 150,
    },
  );
});

test("an explicit detailed primary goal is trimmed, validated and updated", () => {
  const values = profileUpdateValues(
    normaliseProfilePatch({
      expectedUpdatedAt: "2026-08-07T00:00:00.000Z",
      primaryGoal:
        "  Improve strength while keeping enough conditioning for hiking  ",
    }),
    "2026-08-07T00:00:01.000Z",
  );
  assert.deepEqual(values, {
    primaryGoal:
      "Improve strength while keeping enough conditioning for hiking",
    updatedAt: "2026-08-07T00:00:01.000Z",
  });
  assert.throws(
    () =>
      normaliseProfilePatch({
        expectedUpdatedAt: "revision",
        primaryGoal: " ",
      }),
    /primaryGoal must contain 1 to 500 characters/,
  );
  assert.throws(
    () =>
      normaliseProfilePatch({
        expectedUpdatedAt: "revision",
        primaryGoal: "x".repeat(501),
      }),
    /primaryGoal must contain 1 to 500 characters/,
  );
});

test("cycle rename backfill only assigns titles with one current stable phase", () => {
  const backfills = inferTrainingPhaseBackfills(
    parseCycle(undefined, cycle),
    [
      { sessionId: "upper", sessionTitle: "Upper A strength" },
      { sessionId: "lower", sessionTitle: "Lower" },
      { sessionId: "ambiguous", sessionTitle: "Upper A + Lower circuit" },
      { sessionId: "unmatched", sessionTitle: "Trail run" },
    ],
  );
  assert.deepEqual(backfills, [
    { sessionId: "upper", trainingPhaseId: "upper-a" },
    { sessionId: "lower", trainingPhaseId: "lower" },
  ]);
  assert.deepEqual(
    inferTrainingPhaseBackfills(parseCycle("Leg / Push / Pull"), [
      {
        sessionId: "cardio",
        sessionTitle: "Leg Cardio",
        sessionType: "Cardio",
      },
    ]),
    [],
  );
});

test("profile patch rejects ambiguous or unsafe settings", () => {
  for (const preferredLocale of APP_LOCALES) {
    assert.equal(
      normaliseProfilePatch({
        expectedUpdatedAt: "revision",
        preferredLocale,
      }).preferredLocale,
      preferredLocale,
    );
  }
  assert.throws(
    () =>
      normaliseProfilePatch({
        expectedUpdatedAt: "revision",
        preferredLocale: "en-US",
      }),
    /preferredLocale must be one of/,
  );
  assert.deepEqual(
    normaliseProfilePatch({
      expectedUpdatedAt: "revision",
      timezone: " America\/Los_Angeles ",
    }),
    {
      expectedUpdatedAt: "revision",
      timezone: "America/Los_Angeles",
    },
  );
  assert.throws(
    () => normaliseProfilePatch({
      expectedUpdatedAt: "revision",
      timezone: "Hong Kong",
    }),
    /valid IANA timezone/,
  );
  assert.throws(
    () =>
      normaliseProfilePatch({
        expectedUpdatedAt: "revision",
        trainingCycleConfig: {
          version: 1,
          phases: [
            { id: "upper-a", label: "Upper A", kind: "training" },
            { id: "upper-b", label: "upper-a", kind: "training" },
          ],
        },
      }),
    /label must be unique/,
  );
  assert.throws(
    () =>
      normaliseProfilePatch({
        expectedUpdatedAt: "revision",
        trainingCycleConfig: {
          version: 1,
          phases: [{ id: "rest", label: "Rest", kind: "recovery" }],
        },
      }),
    /at least one training phase/,
  );
  assert.throws(
    () => normaliseProfilePatch({ expectedUpdatedAt: "revision" }),
    /no changes/,
  );
});

test("a stable phase id may be renamed or reordered but never change kind", () => {
  assert.doesNotThrow(() =>
    assertStablePhaseKinds(cycle, {
      version: 1,
      phases: [
        { id: "lower", label: "Lower focus", kind: "training" },
        { id: "upper-a", label: "Upper focus", kind: "training" },
        { id: "recover", label: "Easy day", kind: "recovery" },
      ],
    }),
  );
  assert.throws(
    () =>
      assertStablePhaseKinds(cycle, {
        version: 1,
        phases: [
          { id: "upper-a", label: "Upper A", kind: "training" },
          { id: "lower", label: "Lower", kind: "training" },
          { id: "recover", label: "Hard intervals", kind: "training" },
        ],
      }),
    /cannot change kind; use a new id/,
  );
});

test("legacy profile values remain readable before structured setup", () => {
  const response = profileResponse({
    profileId: "owner",
    displayName: null,
    primaryGoal: "Reduce body fat while preserving strength",
    goalType: null,
    trainingCycle: "Upper / Lower / Rest",
    trainingCycleConfig: null,
    strengthProgressExercise: null,
    heightCm: null,
    timezone: "Asia/Hong_Kong",
    preferredLocale: "unsupported",
    setupCompleted: true,
    updatedAt: "2026-08-07T00:00:00.000Z",
  });
  assert.equal(response.goalType, "fat_loss");
  assert.equal(response.preferredLocale, "en");
  assert.equal(response.trainingCycleSource, "legacy");
  assert.deepEqual(
    response.trainingCycleConfig.phases.map(({ id, label, kind }) => ({
      id,
      label,
      kind,
    })),
    [
      { id: "legacy-phase-1", label: "Upper", kind: "training" },
      { id: "legacy-phase-2", label: "Lower", kind: "training" },
      { id: "legacy-phase-3", label: "Rest", kind: "recovery" },
    ],
  );
});

test("goal classification is deterministic and updatedAt always advances", () => {
  assert.equal(classifyGoalType("Build muscle"), "muscle_gain");
  assert.equal(classifyGoalType("Improve endurance"), "endurance");
  assert.equal(classifyGoalType("Move more"), "general");
  assert.equal(
    nextProfileUpdatedAt(
      "2026-08-07T00:00:00.000Z",
      new Date("2026-08-06T00:00:00.000Z"),
    ),
    "2026-08-07T00:00:00.001Z",
  );
});

test("profile route limits agent writes to confirmed block starts and audits them", () => {
  const route = source("app/api/fitness/profile/route.ts");
  assert.match(route, /export async function GET/);
  assert.match(route, /export async function PATCH/);
  assert.match(route, /PROFILE_CONTRACT_VERSION = "2026-08-23\.1"/);
  assert.match(route, /INVALID_PROFILE_PAYLOAD/);
  assert.match(
    route,
    /actor\.kind !== "owner" && actor\.kind !== "fitness-agent"/,
  );
  assert.match(route, /isAgentTrainingBlockPatch\(rawPayload\)/);
  assert.match(
    route,
    /AGENT_TRAINING_BLOCK_FIELDS[\s\S]*?trainingBlockChangeReason[\s\S]*?trainingCycleConfig/,
  );
  assert.match(route, /requiredIdempotencyKey\(request\)/);
  assert.match(route, /findIdempotentReplay/);
  assert.match(route, /eq\(profile\.updatedAt, patch\.expectedUpdatedAt\)/);
  assert.match(route, /entityType: "profile"/);
  assert.match(route, /entityType: "nutrition_target"/);
  assert.match(route, /entityType: "training_block"/);
  assert.match(route, /patch\.trainingBlockChangeReason/);
  assert.match(
    route,
    /const shouldCreateBlock\s*=\s*[\s\S]*?patch\.trainingBlockChangeReason !== undefined/,
  );
  assert.doesNotMatch(
    route,
    /trainingBlockChangeReason requires a primaryGoal or goalType change/,
  );
  assert.match(route, /trainingCycleSnapshot: JSON\.stringify\(blockCycle\)/);
  assert.match(route, /isNull\(trainingNextCourseOverrides\.consumedAt\)/);
  assert.match(route, /isNull\(trainingNextCourseOverrides\.voidedAt\)/);
  assert.match(route, /assertStablePhaseKinds/);
  assert.match(route, /db\.transaction/);
  assert.match(route, /isNull\(workoutSessions\.trainingPhaseId\)/);
  assert.match(route, /isNull\(workoutSessions\.voidedAt\)/);
  assert.match(route, /inferTrainingPhaseBackfills/);
  assert.match(route, /const correctedSessionIds = new Set/);
  assert.match(
    route,
    /projectedBackfills\.appliedCorrections[\s\S]*targetScope === "workout_session"/,
  );
  assert.match(route, /!correctedSessionIds\.has\(session\.sessionId\)/);
  const backfillCall = route.indexOf(
    "const phaseBackfills = inferTrainingPhaseBackfills",
  );
  const profileUpdate = route.indexOf(".update(profile)", backfillCall);
  assert.ok(
    backfillCall >= 0 && profileUpdate > backfillCall,
    "historical phase IDs must be backfilled before the profile cycle changes",
  );
  assert.match(route, /if \(!stored\) throw new ProfileWriteConflict\(\)/);
  assert.match(route, /cache-control.*no-store/s);
});

test("manual body measurements use generic provenance defaults", () => {
  const route = source("app/api/fitness/body-measurements/route.ts");
  assert.match(route, /WEB-MANUAL/);
  assert.match(route, /Manual entry/);
  assert.doesNotMatch(route, /WEB-TANITA|TANITA RD-545/);
});
