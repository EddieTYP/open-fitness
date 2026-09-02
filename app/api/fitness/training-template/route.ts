import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { getDb } from "@/db";
import { auditLog, profile, workoutSessions, workoutSets } from "@/db/schema";
import {
  getApiActor,
  routeError,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { apiError } from "@/lib/api-error";
import { chunkByParameterLimit } from "@/lib/d1-limits";
import { findIdempotentReplay } from "@/lib/idempotency";
import {
  assertStablePhaseKinds,
  inferTrainingPhaseBackfills,
  nextProfileUpdatedAt,
  ProfileValidationError,
} from "@/lib/profile-settings";
import { payloadSha256 } from "@/lib/record-utils";
import {
  effectiveTrainingCycleConfig,
  inferSessionTrainingPhaseId,
  parseCycle,
  TrainingCycleValidationError,
} from "@/lib/training-cycle";
import {
  assertExistingPhaseIdsPreserved,
  deriveTrainingTemplateProposal,
  normaliseTrainingTemplateMutation,
  TrainingTemplateValidationError,
  version2TrainingTemplate,
} from "@/lib/training-template";
import { effectiveWorkoutRecords } from "@/lib/workout-corrections";

export const dynamic = "force-dynamic";

const CONTRACT_VERSION = "2026-08-10.1";
const ENTITY_TYPE = "training_routine_template";
const HISTORY_SESSION_LIMIT = 500;

class TrainingTemplateConflict extends Error {}

function requiredIdempotencyKey(request: Request) {
  const key = request.headers.get("x-idempotency-key")?.trim();
  if (!key) {
    throw new TrainingTemplateValidationError(
      "headers.x-idempotency-key is required",
    );
  }
  if (key.length > 200) {
    throw new TrainingTemplateValidationError(
      "headers.x-idempotency-key must not exceed 200 characters",
    );
  }
  return key;
}

function trainingTemplateRouteError(error: unknown) {
  if (
    error instanceof TrainingTemplateValidationError ||
    error instanceof TrainingCycleValidationError ||
    error instanceof ProfileValidationError
  ) {
    return apiError(
      "INVALID_TRAINING_TEMPLATE",
      400,
      { reason: error.message },
      "Invalid training template",
    );
  }
  if (error instanceof TrainingTemplateConflict) {
    return apiError(
      "TRAINING_TEMPLATE_CONFLICT",
      409,
      {},
      "Training template conflict",
    );
  }
  if (
    error instanceof Error &&
    error.message.includes("Idempotency key conflict")
  ) {
    return apiError(
      "IDEMPOTENCY_KEY_CONFLICT",
      409,
      {},
      "Idempotency key conflict",
    );
  }
  return routeError(error);
}

async function currentProfile() {
  const rows = await getDb().select().from(profile).limit(1);
  return rows[0] ?? null;
}

function templateResponse(row: typeof profile.$inferSelect) {
  return {
    contractVersion: CONTRACT_VERSION,
    profileUpdatedAt: row.updatedAt,
    template: version2TrainingTemplate(
      effectiveTrainingCycleConfig(
        row.trainingCycle,
        row.trainingCycleConfig,
      ),
    ),
  };
}

async function historyProposal(row: typeof profile.$inferSelect) {
  const db = getDb();
  const rawSessions = await db
    .select({
      sessionId: workoutSessions.sessionId,
      trainingPhaseId: workoutSessions.trainingPhaseId,
      sessionTitle: workoutSessions.sessionTitle,
      sessionType: workoutSessions.sessionType,
      startedAt: workoutSessions.startedAt,
      startedAtUtc: workoutSessions.startedAtUtc,
      localDate: workoutSessions.localDate,
    })
    .from(workoutSessions)
    .where(
      and(
        eq(workoutSessions.sessionType, "Strength"),
        isNull(workoutSessions.voidedAt),
      ),
    )
    .orderBy(
      desc(
        sql`coalesce(julianday(${workoutSessions.startedAtUtc}), julianday(${workoutSessions.startedAt}))`,
      ),
      asc(workoutSessions.sessionId),
    )
    .limit(HISTORY_SESSION_LIMIT);
  const sessionIds = rawSessions.map((session) => session.sessionId);
  const rawSets: Array<{
    setId: string;
    sessionId: string;
    exercise: string;
    setNoSession: number;
    weightKgReported: number | null;
    reps: number | null;
    setTypeManual: string | null;
  }> = [];
  for (const sessionIdChunk of chunkByParameterLimit(sessionIds)) {
    rawSets.push(
      ...(await db
        .select({
          setId: workoutSets.setId,
          sessionId: workoutSets.sessionId,
          exercise: workoutSets.exercise,
          setNoSession: workoutSets.setNoSession,
          weightKgReported: workoutSets.weightKgReported,
          reps: workoutSets.reps,
          setTypeManual: workoutSets.setTypeManual,
        })
        .from(workoutSets)
        .where(inArray(workoutSets.sessionId, sessionIdChunk))
        .orderBy(asc(workoutSets.setNoSession))),
    );
  }
  const effective = await effectiveWorkoutRecords(
    { sessions: rawSessions, sets: rawSets },
    db,
  );
  const phases = parseCycle(row.trainingCycle, row.trainingCycleConfig);
  const sessions = effective.sessions.map((session) => ({
    sessionId: session.sessionId,
    trainingPhaseId:
      session.trainingPhaseId ??
      inferSessionTrainingPhaseId(
        phases,
        session.sessionTitle,
        session.sessionType,
      ),
    sessionTitle: session.sessionTitle,
    startedAt: session.startedAt,
    startedAtUtc: session.startedAtUtc,
    localDate: session.localDate,
  }));
  return deriveTrainingTemplateProposal(
    effectiveTrainingCycleConfig(row.trainingCycle, row.trainingCycleConfig),
    sessions,
    effective.sets,
  );
}

export async function GET(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const storedProfile = await currentProfile();
    if (!storedProfile) {
      return apiError("PROFILE_NOT_FOUND", 404, {}, "Profile not found");
    }
    return Response.json(
      {
        ...templateResponse(storedProfile),
        proposal: await historyProposal(storedProfile),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return trainingTemplateRouteError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const mutation = normaliseTrainingTemplateMutation(await request.json());
    const requestId = requiredIdempotencyKey(request);
    const digest = await payloadSha256(mutation);
    const replayedId = await findIdempotentReplay(
      requestId,
      ENTITY_TYPE,
      digest,
    );
    if (replayedId) {
      const replayedProfile = await currentProfile();
      if (!replayedProfile || replayedProfile.profileId !== replayedId) {
        throw new Error("Training template replay is unavailable");
      }
      return Response.json({
        ...templateResponse(replayedProfile),
        requestId,
        replay: true,
      });
    }

    const storedProfile = await currentProfile();
    if (!storedProfile) {
      return apiError("PROFILE_NOT_FOUND", 404, {}, "Profile not found");
    }
    if (storedProfile.updatedAt !== mutation.expectedUpdatedAt) {
      throw new TrainingTemplateConflict();
    }
    const current = effectiveTrainingCycleConfig(
      storedProfile.trainingCycle,
      storedProfile.trainingCycleConfig,
    );
    assertStablePhaseKinds(current, mutation.template);
    assertExistingPhaseIdsPreserved(current, mutation.template);

    const currentPhases = parseCycle(
      storedProfile.trainingCycle,
      storedProfile.trainingCycleConfig,
    );
    const updatedAt = nextProfileUpdatedAt(storedProfile.updatedAt);
    const db = getDb();
    let updated;
    try {
      updated = await db.transaction(async (tx) => {
        const rawBackfillCandidates = await tx
          .select({
            sessionId: workoutSessions.sessionId,
            sessionTitle: workoutSessions.sessionTitle,
            sessionType: workoutSessions.sessionType,
          })
          .from(workoutSessions)
          .where(
            and(
              isNull(workoutSessions.trainingPhaseId),
              isNull(workoutSessions.voidedAt),
            ),
          );
        const projectedBackfills = await effectiveWorkoutRecords(
          { sessions: rawBackfillCandidates },
          tx,
        );
        const correctedSessionIds = new Set(
          projectedBackfills.appliedCorrections
            .filter(
              (correction) =>
                correction.targetScope === "workout_session",
            )
            .map((correction) => correction.targetKey),
        );
        const backfillCandidates = projectedBackfills.sessions.filter(
          (session) => !correctedSessionIds.has(session.sessionId),
        );
        const phaseBackfills = inferTrainingPhaseBackfills(
          currentPhases,
          backfillCandidates,
        );
        for (const backfill of phaseBackfills) {
          await tx
            .update(workoutSessions)
            .set({ trainingPhaseId: backfill.trainingPhaseId })
            .where(
              and(
                eq(workoutSessions.sessionId, backfill.sessionId),
                isNull(workoutSessions.trainingPhaseId),
                isNull(workoutSessions.voidedAt),
              ),
            );
        }

        const rows = await tx
          .update(profile)
          .set({
            trainingCycleConfig: JSON.stringify(mutation.template),
            trainingCycle: mutation.template.phases
              .map((phase) => phase.label)
              .join(" / "),
            updatedAt,
          })
          .where(
            and(
              eq(profile.profileId, storedProfile.profileId),
              eq(profile.updatedAt, mutation.expectedUpdatedAt),
            ),
          )
          .returning();
        const stored = rows[0];
        if (!stored) throw new TrainingTemplateConflict();
        await tx.insert(auditLog).values({
          requestId,
          actor: actor.id,
          operation: "update",
          entityType: ENTITY_TYPE,
          entityId: storedProfile.profileId,
          payloadSha256: digest,
        });
        const readbackRows = await tx
          .select()
          .from(profile)
          .where(eq(profile.profileId, storedProfile.profileId))
          .limit(1);
        const readback = readbackRows[0];
        const readbackTemplate = readback
          ? version2TrainingTemplate(
              effectiveTrainingCycleConfig(
                readback.trainingCycle,
                readback.trainingCycleConfig,
              ),
            )
          : null;
        if (
          !readback ||
          readback.updatedAt !== stored.updatedAt ||
          JSON.stringify(readbackTemplate) !== JSON.stringify(mutation.template)
        ) {
          throw new Error("Training template readback mismatch");
        }
        return readback;
      });
    } catch (error) {
      const racedReplay = await findIdempotentReplay(
        requestId,
        ENTITY_TYPE,
        digest,
      );
      if (!racedReplay || racedReplay !== storedProfile.profileId) throw error;
      const replayedProfile = await currentProfile();
      if (!replayedProfile || replayedProfile.profileId !== racedReplay) {
        throw error;
      }
      return Response.json({
        ...templateResponse(replayedProfile),
        requestId,
        replay: true,
      });
    }

    return Response.json({
      ...templateResponse(updated),
      requestId,
    });
  } catch (error) {
    return trainingTemplateRouteError(error);
  }
}
