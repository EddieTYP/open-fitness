import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  deriveTrainingSchedule,
  normaliseTrainingScheduleMutation,
  normaliseTrainingScheduleRevision,
} from "../lib/training-schedule.ts";

function event({
  id,
  date,
  type,
  resumeOn = null,
  recordedAt = `${date}T00:00:00.000Z`,
  voidedAt = null,
}) {
  return {
    eventId: id,
    profileId: "owner",
    effectiveDate: date,
    eventType: type,
    resumeOn,
    reason: null,
    recordedAt,
    createdBy: "owner",
    voidedAt,
    voidReason: null,
    voidedBy: null,
  };
}

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("indefinite and dated pauses derive without mutating history", () => {
  const indefinite = deriveTrainingSchedule(
    [event({ id: "pause-1", date: "2026-08-05", type: "pause" })],
    "2026-08-09",
  );
  assert.equal(indefinite.status, "paused");
  assert.equal(indefinite.pause.resumeOn, null);

  const datedEvents = [
    event({
      id: "pause-2",
      date: "2026-08-05",
      type: "pause",
      resumeOn: "2026-08-10",
    }),
  ];
  assert.equal(
    deriveTrainingSchedule(datedEvents, "2026-08-09").status,
    "paused",
  );
  const resumed = deriveTrainingSchedule(datedEvents, "2026-08-10");
  assert.equal(resumed.status, "active");
  assert.deepEqual(resumed.intervals[0], {
    eventId: "pause-2",
    startsOn: "2026-08-05",
    resumeOn: "2026-08-10",
    reason: null,
  });
});

test("an early resume closes the pause on its first active date", () => {
  const schedule = deriveTrainingSchedule(
    [
      event({
        id: "pause",
        date: "2026-08-05",
        type: "pause",
        resumeOn: "2026-08-12",
      }),
      event({ id: "resume", date: "2026-08-08", type: "resume" }),
    ],
    "2026-08-08",
  );

  assert.equal(schedule.status, "active");
  assert.equal(schedule.intervals[0].resumeOn, "2026-08-08");
});

test("same-day ordering and soft voiding are deterministic", () => {
  const events = [
    event({
      id: "later-pause",
      date: "2026-08-05",
      type: "pause",
      recordedAt: "2026-08-05T02:00:00.000Z",
    }),
    event({
      id: "earlier-resume",
      date: "2026-08-05",
      type: "resume",
      recordedAt: "2026-08-05T01:00:00.000Z",
    }),
    event({
      id: "voided-resume",
      date: "2026-08-05",
      type: "resume",
      recordedAt: "2026-08-05T03:00:00.000Z",
      voidedAt: "2026-08-05T04:00:00.000Z",
    }),
  ];

  assert.equal(deriveTrainingSchedule(events, "2026-08-05").status, "paused");
});

test("schedule payloads reject aliases and invalid resume dates", () => {
  assert.deepEqual(
    normaliseTrainingScheduleMutation({
      action: "pause",
      effectiveDate: "2026-08-05",
      resumeOn: "2026-08-08",
    }),
    {
      action: "pause",
      effectiveDate: "2026-08-05",
      resumeOn: "2026-08-08",
      reason: null,
    },
  );
  assert.throws(
    () =>
      normaliseTrainingScheduleMutation({
        action: "pause",
        date: "2026-08-05",
      }),
    /unknown field/,
  );
  assert.throws(
    () =>
      normaliseTrainingScheduleMutation({
        action: "pause",
        effectiveDate: "2026-08-05",
        resumeOn: "2026-08-05",
      }),
    /later than effectiveDate/,
  );
  assert.throws(
    () =>
      normaliseTrainingScheduleRevision({
        action: "void",
        eventId: "event-1",
        reason: "",
      }),
    /reason is required/,
  );
});

test("route, dashboard and UI keep schedule writes audited and hidden", async () => {
  const [route, analysis, fitness, revisions, controls, styles, workflow] =
    await Promise.all([
      source("app/api/fitness/training-schedule/route.ts"),
      source("app/api/fitness/analysis/route.ts"),
      source("lib/fitness.ts"),
      source("app/api/fitness/revisions/route.ts"),
      source("components/TrainingScheduleControls.tsx"),
      source("app/globals.css"),
      source("agent-plugin/skills/open-fitness/references/contract.md"),
    ]);

  assert.match(route, /getApiActor\(request\)/);
  assert.match(route, /requiredIdempotencyKey\(request\)/);
  assert.match(route, /findIdempotentReplay/);
  assert.match(route, /db\.batch/);
  assert.match(route, /readback mismatch/);
  assert.match(route, /normaliseTrainingScheduleRevision/);
  assert.match(analysis, /trainingScheduleEvents/);
  assert.match(analysis, /trainingSchedule: \{/);
  assert.match(fitness, /trainingScheduleEvents/);
  assert.match(fitness, /derivedSchedule\.intervals/);
  assert.match(revisions, /training_schedule_event/);
  assert.match(controls, /aria-label=\{t\("fitness\.schedule\.options"\)\}/);
  assert.match(controls, /role="dialog"/);
  assert.match(controls, /fitness\.schedule\.manualResume/);
  assert.match(
    styles,
    /\.training-schedule-menu-trigger \{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/,
  );
  assert.match(
    styles,
    /\.today-kicker \.training-schedule-menu-trigger \{\s*margin-block: -10px;/,
  );
  assert.match(workflow, /trainingSchedule\.status/);
});
