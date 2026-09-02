import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import { getDb } from "@/db";
import {
  auditLog,
  operatingConstraints,
  profile,
  trainingBlocks,
  trainingExerciseSelections,
  trainingNextCourseOverrides,
  trainingPlannedSessions,
  workoutSessions,
  workoutSets,
} from "@/db/schema";
import {
  getApiActor,
  routeError,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { apiError } from "@/lib/api-error";
import { exerciseText } from "@/lib/exercise-display";
import { getDashboardData } from "@/lib/fitness";
import { findIdempotentReplay } from "@/lib/idempotency";
import { sourceText } from "@/lib/i18n/ui-text";
import { effectiveOperatingConstraints } from "@/lib/operating-constraint-corrections";
import { payloadSha256 } from "@/lib/record-utils";
import { exerciseConstraintState } from "@/lib/training-constraints";
import { parseCycle } from "@/lib/training-cycle";
import {
  normaliseTrainingCourseOverride,
  trainingCourseFingerprint,
  TrainingCourseValidationError,
  type TrainingCourseItemOverride,
} from "@/lib/training-course";
import {
  evaluateTrainingProgression,
  trainingProgressionFingerprint,
} from "@/lib/training-progression";
import { dateInTimeZone } from "@/lib/timezone.mjs";
import { effectiveWorkoutRecords } from "@/lib/workout-corrections";

export const dynamic = "force-dynamic";

const CONTRACT_VERSION = "2026-08-23.1";

class TrainingCourseConflict extends Error {}

function requiredIdempotencyKey(request: Request) {
  const key = request.headers.get("x-idempotency-key")?.trim();
  if (!key) {
    throw new TrainingCourseValidationError(
      "headers.x-idempotency-key is required",
    );
  }
  if (key.length > 200) {
    throw new TrainingCourseValidationError(
      "headers.x-idempotency-key must not exceed 200 characters",
    );
  }
  return key;
}

function trainingCourseRouteError(error: unknown) {
  if (error instanceof TrainingCourseValidationError) {
    return apiError(
      "INVALID_TRAINING_COURSE_OVERRIDE",
      400,
      { reason: error.message },
      "Invalid training course override",
    );
  }
  if (error instanceof TrainingCourseConflict) {
    return apiError(
      "TRAINING_COURSE_CONFLICT",
      409,
      {},
      "Training course changed; refresh and try again",
    );
  }
  return routeError(error);
}

async function currentProfile() {
  const rows = await getDb().select().from(profile).limit(1);
  return rows[0] ?? null;
}

async function rowsForBatch(
  overrideBatchId: string,
  scope: "date" | "next_normal_occurrence" | "planned_session",
) {
  return scope === "date" || scope === "planned_session"
    ? getDb()
        .select()
        .from(trainingExerciseSelections)
        .where(eq(trainingExerciseSelections.overrideBatchId, overrideBatchId))
    : getDb()
        .select()
        .from(trainingNextCourseOverrides)
        .where(
          eq(trainingNextCourseOverrides.overrideBatchId, overrideBatchId),
        );
}

async function activeDateSelectionIds(
  rows: Array<typeof trainingExerciseSelections.$inferSelect>,
) {
  if (rows.length === 0) return new Set<string>();
  const first = rows[0];
  const candidates = await getDb()
    .select()
    .from(trainingExerciseSelections)
    .where(
      and(
        eq(trainingExerciseSelections.profileId, first.profileId),
        eq(trainingExerciseSelections.phaseId, first.phaseId),
        eq(trainingExerciseSelections.scope, "date"),
        eq(trainingExerciseSelections.scopeValue, first.scopeValue),
        inArray(
          trainingExerciseSelections.slotId,
          rows.map((row) => row.slotId),
        ),
      ),
    )
    .orderBy(
      desc(trainingExerciseSelections.recordedAt),
      desc(trainingExerciseSelections.selectionId),
    );
  const active = new Map<string, string>();
  for (const candidate of candidates) {
    if (!active.has(candidate.slotId)) {
      active.set(candidate.slotId, candidate.selectionId);
    }
  }
  return new Set(active.values());
}

async function courseRecordsForBatch(
  overrideBatchId: string,
  scope: "date" | "next_normal_occurrence" | "planned_session",
) {
  const rows = await rowsForBatch(overrideBatchId, scope);
  if (scope === "next_normal_occurrence") {
    return rows.map((row) => {
      if (!("overrideId" in row)) {
        throw new Error("Training course readback mismatch");
      }
      const lifecycle = row.voidedAt
        ? "voided"
        : row.consumedAt
          ? "consumed"
          : "active";
      return {
        recordId: row.overrideId,
        overrideBatchId,
        scope,
        lifecycle,
        active: lifecycle === "active",
        phaseId: row.phaseId,
        trainingBlockId: row.trainingBlockId,
        date: null,
        plannedSessionId: null,
        sessionIntent: "normal",
        sourceSessionId: row.sourceSessionId,
        slotId: row.slotId,
        exercise: row.exercise,
        prescription: row.prescriptionOverride,
        loadGuidance: row.loadGuidanceOverride,
        effort: row.effortOverride,
        consumedBySessionId: row.consumedBySessionId,
        consumedAt: row.consumedAt,
        voidedAt: row.voidedAt,
        recordedAt: row.recordedAt,
      };
    });
  }

  const selectionRows = rows.filter(
    (row): row is typeof trainingExerciseSelections.$inferSelect =>
      "selectionId" in row,
  );
  const activeSelectionIds = await activeDateSelectionIds(selectionRows);
  const plannedRows =
    scope === "planned_session"
      ? await getDb()
          .select()
          .from(trainingPlannedSessions)
          .where(eq(trainingPlannedSessions.overrideBatchId, overrideBatchId))
          .limit(1)
      : [];
  const plannedSession = plannedRows[0] ?? null;
  if (scope === "planned_session" && !plannedSession) {
    throw new Error("Training planned session readback mismatch");
  }

  return selectionRows.map((row) => {
    const lifecycle = plannedSession?.voidedAt
      ? "voided"
      : plannedSession?.consumedAt
        ? "consumed"
        : activeSelectionIds.has(row.selectionId)
          ? "active"
          : "superseded";
    return {
      recordId: row.selectionId,
      overrideBatchId,
      scope,
      lifecycle,
      active: lifecycle === "active",
      phaseId: row.phaseId,
      trainingBlockId: plannedSession?.trainingBlockId ?? null,
      date: row.scopeValue,
      plannedSessionId: plannedSession?.planId ?? null,
      sessionIntent: plannedSession?.sessionIntent ?? "normal",
      sourceSessionId: null,
      slotId: row.slotId,
      exercise: row.exercise,
      prescription: row.prescriptionOverride,
      loadGuidance: row.loadGuidanceOverride,
      effort: row.effortOverride,
      consumedBySessionId: plannedSession?.consumedBySessionId ?? null,
      consumedAt: plannedSession?.consumedAt ?? null,
      voidedAt: plannedSession?.voidedAt ?? null,
      recordedAt: row.recordedAt,
    };
  });
}

function resultEntityType(entityType: string) {
  return `${entityType}_result`;
}

async function replayedPlanFingerprint(
  requestId: string,
  entityType: string,
  digest: string,
) {
  const fingerprint = await findIdempotentReplay(
    requestId,
    resultEntityType(entityType),
    digest,
  );
  if (fingerprint && !/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error("Training course result metadata is invalid");
  }
  return fingerprint;
}

function postWritePlanFingerprint(
  plan: NonNullable<
    Awaited<ReturnType<typeof getDashboardData>>["todayPlan"]
  >,
  items: TrainingCourseItemOverride[],
) {
  const bySlot = new Map(items.map((item) => [item.slotId, item]));
  return trainingCourseFingerprint({
    planningDate: plan.planningDate,
    phaseId: plan.phaseId,
    items: plan.items.map((item) => {
      const override = item.slotId ? bySlot.get(item.slotId) : null;
      return override
        ? {
            ...item,
            exercise: exerciseText(override.exercise),
            prescription: sourceText(override.prescription),
            loadGuidance: sourceText(override.loadGuidance),
            effort: sourceText(override.effort),
          }
        : item;
    }),
  });
}

type CourseReadDb = Pick<ReturnType<typeof getDb>, "select">;
type NextCourseMutation = Extract<
  ReturnType<typeof normaliseTrainingCourseOverride>,
  { scope: "next_normal_occurrence" }
>;

async function currentProgressionEvidence(
  db: CourseReadDb,
  storedProfile: typeof profile.$inferSelect,
  activeBlock: typeof trainingBlocks.$inferSelect | null,
  mutation: NextCourseMutation,
) {
  if (
    !activeBlock ||
    activeBlock.blockId !== mutation.trainingBlockId ||
    !mutation.sourceSessionId
  ) {
    return null;
  }
  const phase = parseCycle(
    storedProfile.trainingCycle,
    activeBlock.trainingCycleSnapshot,
  ).find((candidate) => candidate.id === mutation.phaseId);
  if (!phase || phase.kind !== "training") return null;

  const rawSessions = await db
    .select()
    .from(workoutSessions)
    .where(
      and(
        eq(workoutSessions.trainingBlockId, activeBlock.blockId),
        eq(workoutSessions.trainingPhaseId, phase.id),
        isNull(workoutSessions.voidedAt),
      ),
    )
    .orderBy(
      desc(workoutSessions.startedAtUtc),
      desc(workoutSessions.startedAt),
    );
  const sessionIds = rawSessions.map((session) => session.sessionId);
  const rawSets = sessionIds.length
    ? await db
        .select()
        .from(workoutSets)
        .where(inArray(workoutSets.sessionId, sessionIds))
        .orderBy(workoutSets.sessionId, workoutSets.setNoSession)
    : [];
  const projected = await effectiveWorkoutRecords(
    { sessions: rawSessions, sets: rawSets },
    db,
  );
  const rawConstraints = await db
    .select()
    .from(operatingConstraints)
    .orderBy(desc(operatingConstraints.effectiveDate));
  const today = dateInTimeZone(new Date(), storedProfile.timezone);
  const { constraints } = await effectiveOperatingConstraints(
    rawConstraints,
    today,
    db,
  );
  const constrainedExercises = (phase.routine ?? []).flatMap((slot) =>
    [slot.preferredExercise, ...slot.alternatives].filter((exercise) => {
      const state = exerciseConstraintState(exercise, constraints);
      return state.paused || state.conditional;
    }),
  );
  return {
    progression: evaluateTrainingProgression({
      phase,
      trainingBlockId: activeBlock.blockId,
      sessions: projected.sessions,
      sets: projected.sets,
      constrainedExercises,
    }),
    fingerprint: trainingProgressionFingerprint({
      phase,
      trainingBlockId: activeBlock.blockId,
      sessions: projected.sessions,
      sets: projected.sets,
      constrainedExercises,
    }),
  };
}

async function courseGenerationToken(
  db: CourseReadDb,
  profileId: string,
  mutation: ReturnType<typeof normaliseTrainingCourseOverride>,
) {
  const slotIds = mutation.items.map((item) => item.slotId);
  if (mutation.scope === "next_normal_occurrence") {
    const overrides = await db
      .select({
        overrideId: trainingNextCourseOverrides.overrideId,
        slotId: trainingNextCourseOverrides.slotId,
      })
      .from(trainingNextCourseOverrides)
      .where(
        and(
          eq(trainingNextCourseOverrides.profileId, profileId),
          eq(
            trainingNextCourseOverrides.trainingBlockId,
            mutation.trainingBlockId,
          ),
          eq(trainingNextCourseOverrides.phaseId, mutation.phaseId),
          inArray(trainingNextCourseOverrides.slotId, slotIds),
          isNull(trainingNextCourseOverrides.consumedAt),
          isNull(trainingNextCourseOverrides.voidedAt),
        ),
      )
      .orderBy(
        trainingNextCourseOverrides.slotId,
        trainingNextCourseOverrides.overrideId,
      );
    return payloadSha256(overrides);
  }

  const selectionRows = await db
    .select({
      selectionId: trainingExerciseSelections.selectionId,
      slotId: trainingExerciseSelections.slotId,
    })
    .from(trainingExerciseSelections)
    .where(
      and(
        eq(trainingExerciseSelections.profileId, profileId),
        eq(trainingExerciseSelections.phaseId, mutation.phaseId),
        eq(trainingExerciseSelections.scope, "date"),
        eq(trainingExerciseSelections.scopeValue, mutation.date),
        inArray(trainingExerciseSelections.slotId, slotIds),
      ),
    )
    .orderBy(
      desc(trainingExerciseSelections.recordedAt),
      desc(trainingExerciseSelections.selectionId),
    );
  const selections = selectionRows;
  if (mutation.scope === "date") return payloadSha256(selections);

  const plannedSessions = await db
    .select({ planId: trainingPlannedSessions.planId })
    .from(trainingPlannedSessions)
    .where(
      and(
        eq(trainingPlannedSessions.profileId, profileId),
        eq(
          trainingPlannedSessions.trainingBlockId,
          mutation.trainingBlockId,
        ),
        eq(trainingPlannedSessions.phaseId, mutation.phaseId),
        eq(trainingPlannedSessions.localDate, mutation.date),
        isNull(trainingPlannedSessions.consumedAt),
        isNull(trainingPlannedSessions.voidedAt),
      ),
    )
    .orderBy(trainingPlannedSessions.planId);
  return payloadSha256({ plannedSessions, selections });
}

export async function POST(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const mutation = normaliseTrainingCourseOverride(await request.json());
    const requestId = requiredIdempotencyKey(request);
    const digest = await payloadSha256(mutation);
    const entityType =
      mutation.scope === "date"
        ? "training_course_override"
        : mutation.scope === "planned_session"
          ? "training_planned_session"
          : "training_next_course_override";
    const replayedBatchId = await findIdempotentReplay(
      requestId,
      entityType,
      digest,
    );
    if (replayedBatchId) {
      const records = await courseRecordsForBatch(
        replayedBatchId,
        mutation.scope,
      );
      if (records.length !== mutation.items.length) {
        throw new Error("Training course replay is unavailable");
      }
      return Response.json({
        contractVersion: CONTRACT_VERSION,
        overrideBatchId: replayedBatchId,
        scope: mutation.scope,
        recordIds: records.map((record) => record.recordId),
        records,
        planningDate:
          mutation.scope === "date" || mutation.scope === "planned_session"
            ? mutation.date
            : null,
        phaseId: mutation.phaseId,
        planFingerprint: await replayedPlanFingerprint(
          requestId,
          entityType,
          digest,
        ),
        sessionIntent:
          mutation.scope === "planned_session"
            ? mutation.sessionIntent
            : mutation.scope === "date"
              ? "normal"
              : null,
        progressionFingerprint:
          mutation.scope === "next_normal_occurrence"
            ? mutation.expectedProgressionFingerprint
            : null,
        requestId,
        replay: true,
      });
    }

    const storedProfile = await currentProfile();
    if (!storedProfile) {
      return apiError("PROFILE_NOT_FOUND", 404, {}, "Profile not found");
    }
    const db = getDb();
    const activeBlocks = await db
      .select()
      .from(trainingBlocks)
      .where(
        and(
          eq(trainingBlocks.profileId, storedProfile.profileId),
          isNull(trainingBlocks.endsOn),
        ),
      )
      .limit(1);
    const activeBlock = activeBlocks[0] ?? null;
    const expectedCourseGeneration = await courseGenerationToken(
      db,
      storedProfile.profileId,
      mutation,
    );
    let datePlan: Awaited<ReturnType<typeof getDashboardData>>["todayPlan"] = null;
    let progressionFingerprint: string | null = null;

    if (mutation.scope === "date" || mutation.scope === "planned_session") {
      const dashboard = await getDashboardData();
      datePlan = dashboard.todayPlan;
      if (
        dashboard.status === "unavailable" ||
        !datePlan ||
        datePlan.phaseId !== mutation.phaseId ||
        datePlan.planningDate !== mutation.date ||
        datePlan.planFingerprint !== mutation.expectedPlanFingerprint
      ) {
        throw new TrainingCourseConflict();
      }
      if (
        mutation.scope === "planned_session" &&
        (!activeBlock || activeBlock.blockId !== mutation.trainingBlockId)
      ) {
        throw new TrainingCourseConflict();
      }
      const plannedItems = datePlan.items.filter(
        (item) =>
          item.phaseId === mutation.phaseId && typeof item.slotId === "string",
      );
      const plannedBySlot = new Map(
        plannedItems.map((item) => [item.slotId!, item]),
      );
      if (
        plannedBySlot.size !== mutation.items.length ||
        mutation.items.some((item) => !plannedBySlot.has(item.slotId))
      ) {
        throw new TrainingCourseValidationError(
          "items must include every working item in dashboard.todayPlan exactly once",
        );
      }
      for (const item of mutation.items) {
        if (plannedBySlot.get(item.slotId)?.exerciseKey !== item.exercise) {
          throw new TrainingCourseValidationError(
            `items.${item.slotId}.exercise must match dashboard.todayPlan.items[].exerciseKey`,
          );
        }
      }
    } else {
      const evidence = await currentProgressionEvidence(
        db,
        storedProfile,
        activeBlock,
        mutation,
      );
      if (
        !evidence ||
        evidence.fingerprint !== mutation.expectedProgressionFingerprint
      ) {
        throw new TrainingCourseConflict();
      }
      progressionFingerprint = evidence.fingerprint;
      const proposalsBySlot = new Map(
        evidence.progression.proposals.map((proposal) => [
          proposal.slotId,
          proposal,
        ]),
      );
      for (const item of mutation.items) {
        const proposal = proposalsBySlot.get(item.slotId);
        if (
          !proposal ||
          proposal.exercise !== item.exercise ||
          proposal.sourceSessionIds[1] !== mutation.sourceSessionId
        ) {
          throw new TrainingCourseConflict();
        }
      }
    }

    let planFingerprint: string | null = null;
    const overrideBatchId = `TRAINING-COURSE|${await payloadSha256({
      requestId,
      entityType,
    })}`;
    const recordedAt = new Date().toISOString();
    const plannedRows = mutation.items.map((item) => ({ item }));
    const dateRows =
      mutation.scope === "date" || mutation.scope === "planned_session"
        ? plannedRows.map(({ item }) => ({
            selectionId: `TRAINING-SELECTION|${crypto.randomUUID()}`,
            profileId: storedProfile.profileId,
            phaseId: mutation.phaseId,
            slotId: item.slotId,
            scope: "date" as const,
            scopeValue: mutation.date,
            exercise: item.exercise,
            overrideBatchId,
            prescriptionOverride: item.prescription,
            loadGuidanceOverride: item.loadGuidance,
            effortOverride: item.effort,
            recordedAt,
            createdBy: actor.id,
          }))
        : [];
    const nextRows =
      mutation.scope === "next_normal_occurrence"
        ? plannedRows.map(({ item }) => ({
            overrideId: `TRAINING-NEXT|${crypto.randomUUID()}`,
            overrideBatchId,
            profileId: storedProfile.profileId,
            trainingBlockId: mutation.trainingBlockId,
            phaseId: mutation.phaseId,
            slotId: item.slotId,
            exercise: item.exercise,
            prescriptionOverride: item.prescription,
            loadGuidanceOverride: item.loadGuidance,
            effortOverride: item.effort,
            sourceSessionId: mutation.sourceSessionId,
            recordedAt,
            createdBy: actor.id,
          }))
        : [];
    const plannedSessionRow =
      mutation.scope === "planned_session"
        ? {
            planId: `TRAINING-PLAN|${crypto.randomUUID()}`,
            overrideBatchId,
            profileId: storedProfile.profileId,
            trainingBlockId: mutation.trainingBlockId,
            phaseId: mutation.phaseId,
            localDate: mutation.date,
            sessionIntent: mutation.sessionIntent,
            recordedAt,
            createdBy: actor.id,
          }
        : null;
    try {
      await db.transaction(async (tx) => {
        // Local libSQL write transactions use BEGIN IMMEDIATE, so no writer can
        // change the compared generation or evidence before the writes below.
        if (
          (await courseGenerationToken(
            tx,
            storedProfile.profileId,
            mutation,
          )) !== expectedCourseGeneration
        ) {
          throw new TrainingCourseConflict();
        }

        if (mutation.scope === "date" || mutation.scope === "planned_session") {
          const lockedDashboard = await getDashboardData();
          const lockedPlan = lockedDashboard.todayPlan;
          if (
            lockedDashboard.status === "unavailable" ||
            !lockedPlan ||
            lockedPlan.phaseId !== mutation.phaseId ||
            lockedPlan.planningDate !== mutation.date ||
            lockedPlan.planFingerprint !== mutation.expectedPlanFingerprint
          ) {
            throw new TrainingCourseConflict();
          }
          if (mutation.scope === "planned_session") {
            const lockedActiveBlocks = await tx
              .select()
              .from(trainingBlocks)
              .where(
                and(
                  eq(trainingBlocks.profileId, storedProfile.profileId),
                  isNull(trainingBlocks.endsOn),
                ),
              )
              .limit(1);
            if (
              lockedActiveBlocks[0]?.blockId !== mutation.trainingBlockId
            ) {
              throw new TrainingCourseConflict();
            }
          }
          datePlan = lockedPlan;
          planFingerprint = postWritePlanFingerprint(datePlan, mutation.items);
        } else {
          const lockedProfiles = await tx.select().from(profile).limit(1);
          const lockedProfile = lockedProfiles[0] ?? null;
          const lockedActiveBlocks = lockedProfile
            ? await tx
                .select()
                .from(trainingBlocks)
                .where(
                  and(
                    eq(trainingBlocks.profileId, lockedProfile.profileId),
                    isNull(trainingBlocks.endsOn),
                  ),
                )
                .limit(1)
            : [];
          const lockedEvidence = lockedProfile
            ? await currentProgressionEvidence(
                tx,
                lockedProfile,
                lockedActiveBlocks[0] ?? null,
                mutation,
              )
            : null;
          if (
            !lockedProfile ||
            lockedProfile.profileId !== storedProfile.profileId ||
            !lockedEvidence ||
            lockedEvidence.fingerprint !==
              mutation.expectedProgressionFingerprint
          ) {
            throw new TrainingCourseConflict();
          }
          progressionFingerprint = lockedEvidence.fingerprint;
        }

        if (mutation.scope === "date") {
          await tx.insert(trainingExerciseSelections).values(dateRows);
        } else if (mutation.scope === "planned_session") {
          await tx
            .update(trainingPlannedSessions)
            .set({ voidedAt: recordedAt })
            .where(
              and(
                eq(trainingPlannedSessions.profileId, storedProfile.profileId),
                eq(
                  trainingPlannedSessions.trainingBlockId,
                  mutation.trainingBlockId,
                ),
                eq(trainingPlannedSessions.phaseId, mutation.phaseId),
                eq(trainingPlannedSessions.localDate, mutation.date),
                isNull(trainingPlannedSessions.consumedAt),
                isNull(trainingPlannedSessions.voidedAt),
              ),
            );
          await tx.insert(trainingExerciseSelections).values(dateRows);
          await tx.insert(trainingPlannedSessions).values(plannedSessionRow!);
        } else {
          await tx
            .update(trainingNextCourseOverrides)
            .set({ voidedAt: recordedAt })
            .where(
              and(
                eq(
                  trainingNextCourseOverrides.profileId,
                  storedProfile.profileId,
                ),
                eq(
                  trainingNextCourseOverrides.trainingBlockId,
                  mutation.trainingBlockId,
                ),
                eq(trainingNextCourseOverrides.phaseId, mutation.phaseId),
                inArray(
                  trainingNextCourseOverrides.slotId,
                  mutation.items.map((item) => item.slotId),
                ),
                isNull(trainingNextCourseOverrides.consumedAt),
                isNull(trainingNextCourseOverrides.voidedAt),
              ),
            );
          await tx.insert(trainingNextCourseOverrides).values(nextRows);
        }
        await tx.insert(auditLog).values({
          requestId,
          actor: actor.id,
          operation: "insert",
          entityType,
          entityId: overrideBatchId,
          payloadSha256: digest,
        });
        if (planFingerprint) {
          await tx.insert(auditLog).values({
            requestId,
            actor: actor.id,
            operation: "readback",
            entityType: resultEntityType(entityType),
            entityId: planFingerprint,
            payloadSha256: digest,
          });
        }
      });
    } catch (error) {
      const concurrentReplayBatchId = await findIdempotentReplay(
        requestId,
        entityType,
        digest,
      );
      if (!concurrentReplayBatchId) throw error;
      const replayRecords = await courseRecordsForBatch(
        concurrentReplayBatchId,
        mutation.scope,
      );
      if (replayRecords.length !== mutation.items.length) {
        throw new Error("Training course replay is unavailable");
      }
      return Response.json({
        contractVersion: CONTRACT_VERSION,
        overrideBatchId: concurrentReplayBatchId,
        scope: mutation.scope,
        recordIds: replayRecords.map((record) => record.recordId),
        records: replayRecords,
        planningDate:
          mutation.scope === "date" || mutation.scope === "planned_session"
            ? mutation.date
            : null,
        phaseId: mutation.phaseId,
        planFingerprint: await replayedPlanFingerprint(
          requestId,
          entityType,
          digest,
        ),
        sessionIntent:
          mutation.scope === "planned_session"
            ? mutation.sessionIntent
            : mutation.scope === "date"
              ? "normal"
              : null,
        progressionFingerprint:
          mutation.scope === "next_normal_occurrence"
            ? mutation.expectedProgressionFingerprint
            : null,
        requestId,
        replay: true,
      });
    }

    const records = await courseRecordsForBatch(
      overrideBatchId,
      mutation.scope,
    );
    if (
      records.length !== mutation.items.length ||
      mutation.items.some((expected) => {
        const actual = records.find(
          (record) => record.slotId === expected.slotId,
        );
        return (
          !actual ||
          actual.scope !== mutation.scope ||
          actual.phaseId !== mutation.phaseId ||
          actual.exercise !== expected.exercise ||
          actual.prescription !== expected.prescription ||
          actual.loadGuidance !== expected.loadGuidance ||
          actual.effort !== expected.effort ||
          (mutation.scope === "date" && actual.date !== mutation.date) ||
          (mutation.scope === "planned_session" &&
            (actual.date !== mutation.date ||
              actual.trainingBlockId !== mutation.trainingBlockId ||
              actual.sessionIntent !== mutation.sessionIntent)) ||
          (mutation.scope === "next_normal_occurrence" &&
            (actual.trainingBlockId !== mutation.trainingBlockId ||
              actual.sourceSessionId !== mutation.sourceSessionId))
        );
      })
    ) {
      throw new Error("Training course readback mismatch");
    }

    return Response.json(
      {
        contractVersion: CONTRACT_VERSION,
        overrideBatchId,
        scope: mutation.scope,
        recordIds: records.map((record) => record.recordId),
        records,
        planningDate:
          mutation.scope === "date" || mutation.scope === "planned_session"
            ? mutation.date
            : null,
        phaseId: mutation.phaseId,
        planFingerprint,
        sessionIntent:
          mutation.scope === "planned_session"
            ? mutation.sessionIntent
            : mutation.scope === "date"
              ? "normal"
              : null,
        progressionFingerprint,
        requestId,
        replay: false,
      },
      { status: 201 },
    );
  } catch (error) {
    return trainingCourseRouteError(error);
  }
}
