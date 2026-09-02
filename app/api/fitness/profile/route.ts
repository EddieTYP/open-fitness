import { and, desc, eq, isNull, lte, ne } from "drizzle-orm";

import { getDb } from "@/db";
import {
  auditLog,
  nutritionSettings,
  profile,
  trainingBlocks,
  trainingNextCourseOverrides,
  workoutSessions,
} from "@/db/schema";
import {
  getApiActor,
  routeError,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { apiError } from "@/lib/api-error";
import { findIdempotentReplay } from "@/lib/idempotency";
import {
  nutritionTargetInsertValues,
  NutritionTargetValidationError,
} from "@/lib/nutrition-targets";
import {
  assertStablePhaseKinds,
  classifyGoalType,
  inferTrainingPhaseBackfills,
  nextProfileUpdatedAt,
  normaliseProfilePatch,
  ProfileValidationError,
  profileResponse,
  profileUpdateValues,
} from "@/lib/profile-settings";
import { payloadSha256 } from "@/lib/record-utils";
import {
  effectiveTrainingCycleConfig,
  parseCycle,
  TrainingCycleValidationError,
} from "@/lib/training-cycle";
import { dateInTimeZone } from "@/lib/timezone.mjs";
import { effectiveWorkoutRecords } from "@/lib/workout-corrections";

export const dynamic = "force-dynamic";

const PROFILE_CONTRACT_VERSION = "2026-08-23.1";
const AGENT_TRAINING_BLOCK_FIELDS = new Set([
  "expectedUpdatedAt",
  "goalType",
  "primaryGoal",
  "trainingBlockChangeReason",
  "trainingCycleConfig",
]);

function isAgentTrainingBlockPatch(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload);
  return (
    keys.every((key) => AGENT_TRAINING_BLOCK_FIELDS.has(key)) &&
    [
      "expectedUpdatedAt",
      "goalType",
      "primaryGoal",
      "trainingBlockChangeReason",
    ].every((key) => Object.hasOwn(payload, key))
  );
}

class ProfileWriteConflict extends Error {}

function requiredIdempotencyKey(request: Request) {
  const key = request.headers.get("x-idempotency-key")?.trim();
  if (!key) {
    throw new ProfileValidationError("headers.x-idempotency-key is required");
  }
  if (key.length > 200) {
    throw new ProfileValidationError(
      "headers.x-idempotency-key must not exceed 200 characters",
    );
  }
  return key;
}

function profileRouteError(error: unknown) {
  if (
    error instanceof ProfileValidationError ||
    error instanceof NutritionTargetValidationError ||
    error instanceof TrainingCycleValidationError
  ) {
    return apiError(
      "INVALID_PROFILE_PAYLOAD",
      400,
      { reason: error.message },
      "Invalid profile payload",
    );
  }
  return routeError(error);
}

async function firstProfile() {
  const rows = await getDb().select().from(profile).limit(1);
  return rows[0] ?? null;
}

async function profileById(profileId: string) {
  const rows = await getDb()
    .select()
    .from(profile)
    .where(eq(profile.profileId, profileId))
    .limit(1);
  return rows[0] ?? null;
}

async function activeTrainingBlock(profileId: string) {
  const rows = await getDb()
    .select()
    .from(trainingBlocks)
    .where(
      and(
        eq(trainingBlocks.profileId, profileId),
        isNull(trainingBlocks.endsOn),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function effectiveNutritionTarget(effectiveDate: string) {
  const rows = await getDb()
    .select()
    .from(nutritionSettings)
    .where(
      and(
        lte(nutritionSettings.effectiveFrom, effectiveDate),
        ne(nutritionSettings.status, "retired"),
      ),
    )
    .orderBy(
      desc(nutritionSettings.effectiveFrom),
      desc(nutritionSettings.createdAt),
      desc(nutritionSettings.settingsId),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function GET(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const current = await firstProfile();
    if (!current) {
      return apiError("PROFILE_NOT_FOUND", 404, {}, "Profile not found");
    }
    const effectiveDate = dateInTimeZone(new Date(), current.timezone);
    const [target, block] = await Promise.all([
      effectiveNutritionTarget(effectiveDate),
      activeTrainingBlock(current.profileId),
    ]);
    return Response.json(
      {
        contractVersion: PROFILE_CONTRACT_VERSION,
        actor: actor.kind,
        effectiveDate,
        profile: profileResponse(current, target, block),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return profileRouteError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();
    if (actor.kind !== "owner" && actor.kind !== "fitness-agent") {
      return apiError(
        "OWNER_ACCESS_REQUIRED",
        403,
        {},
        "Owner access required",
      );
    }

    const rawPayload: unknown = await request.json();
    if (
      actor.kind === "fitness-agent" &&
      !isAgentTrainingBlockPatch(rawPayload)
    ) {
      return apiError(
        "OWNER_ACCESS_REQUIRED",
        403,
        {},
        "Owner access required",
      );
    }
    const patch = normaliseProfilePatch(rawPayload);
    const idempotencyKey = requiredIdempotencyKey(request);
    const digest = await payloadSha256(patch);
    const replayedId = await findIdempotentReplay(
      idempotencyKey,
      "profile",
      digest,
    );
    if (replayedId) {
      const replayedProfile = await profileById(replayedId);
      if (!replayedProfile) {
        throw new Error("Profile replay is unavailable");
      }
      const [replayedTarget, replayedBlock] = await Promise.all([
        effectiveNutritionTarget(
          dateInTimeZone(new Date(), replayedProfile.timezone),
        ),
        activeTrainingBlock(replayedProfile.profileId),
      ]);
      return Response.json({
        contractVersion: PROFILE_CONTRACT_VERSION,
        profile: profileResponse(
          replayedProfile,
          replayedTarget,
          replayedBlock,
        ),
        requestId: idempotencyKey,
        replay: true,
      });
    }

    const current = await firstProfile();
    if (!current) {
      return apiError("PROFILE_NOT_FOUND", 404, {}, "Profile not found");
    }
    if (current.updatedAt !== patch.expectedUpdatedAt) {
      return apiError(
        "PROFILE_WRITE_CONFLICT",
        409,
        { currentUpdatedAt: current.updatedAt },
        "Profile write conflict",
      );
    }
    const goalChanged =
      (patch.primaryGoal !== undefined &&
        patch.primaryGoal !== current.primaryGoal) ||
      (patch.goalType !== undefined && patch.goalType !== current.goalType);
    if (
      !current.setupCompleted &&
      patch.setupCompleted === true &&
      !patch.nutritionTarget
    ) {
      throw new NutritionTargetValidationError(
        "nutritionTarget is required when completing initial setup",
      );
    }
    const currentPhases = patch.trainingCycleConfig
      ? parseCycle(current.trainingCycle, current.trainingCycleConfig)
      : null;
    if (patch.trainingCycleConfig) {
      assertStablePhaseKinds(
        effectiveTrainingCycleConfig(
          current.trainingCycle,
          current.trainingCycleConfig,
        ),
        patch.trainingCycleConfig,
      );
    }

    const updatedAt = nextProfileUpdatedAt(current.updatedAt);
    const values = profileUpdateValues(patch, updatedAt);
    const existingBlock = await activeTrainingBlock(current.profileId);
    const shouldCreateBlock =
      goalChanged ||
      patch.trainingBlockChangeReason !== undefined ||
      existingBlock === null;
    const blockStartsOn = dateInTimeZone(
      new Date(),
      patch.timezone ?? current.timezone,
    );
    const blockId = shouldCreateBlock
      ? `TRAINING-BLOCK|${crypto.randomUUID()}`
      : null;
    const blockGoal = patch.primaryGoal ?? current.primaryGoal;
    const blockGoalType =
      patch.goalType ??
      current.goalType ??
      classifyGoalType(blockGoal);
    const blockCycle =
      patch.trainingCycleConfig ??
      effectiveTrainingCycleConfig(
        current.trainingCycle,
        current.trainingCycleConfig,
      );
    const inheritedTarget = patch.nutritionTarget
      ? await effectiveNutritionTarget(patch.nutritionTarget.effectiveFrom)
      : null;
    const targetValues = patch.nutritionTarget
      ? nutritionTargetInsertValues(patch.nutritionTarget, inheritedTarget)
      : null;
    const targetDigest = patch.nutritionTarget
      ? await payloadSha256(patch.nutritionTarget)
      : null;
    const db = getDb();
    let updated;
    let storedTarget: typeof nutritionSettings.$inferSelect | null = null;
    try {
      const transactionResult = await db.transaction(async (tx) => {
        if (currentPhases) {
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
        }

        const rows = await tx
          .update(profile)
          .set(values)
          .where(
            and(
              eq(profile.profileId, current.profileId),
              eq(profile.updatedAt, patch.expectedUpdatedAt),
            ),
          )
          .returning();
        const stored = rows[0];
        if (!stored) throw new ProfileWriteConflict();
        let savedBlock: typeof trainingBlocks.$inferSelect | null = null;
        if (shouldCreateBlock && blockId) {
          if (existingBlock) {
            await tx
              .update(trainingBlocks)
              .set({ endsOn: blockStartsOn })
              .where(eq(trainingBlocks.blockId, existingBlock.blockId));
            await tx
              .update(trainingNextCourseOverrides)
              .set({ voidedAt: updatedAt })
              .where(
                and(
                  eq(
                    trainingNextCourseOverrides.trainingBlockId,
                    existingBlock.blockId,
                  ),
                  isNull(trainingNextCourseOverrides.consumedAt),
                  isNull(trainingNextCourseOverrides.voidedAt),
                ),
              );
          }
          const blockRows = await tx
            .insert(trainingBlocks)
            .values({
              blockId,
              profileId: current.profileId,
              goalType: blockGoalType,
              primaryGoal: blockGoal,
              trainingCycleSnapshot: JSON.stringify(blockCycle),
              startsOn: blockStartsOn,
              endsOn: null,
              changeReason:
                patch.trainingBlockChangeReason ??
                (goalChanged ? "Profile goal updated" : "Initial setup"),
              createdBy: actor.id,
            })
            .returning();
          savedBlock = blockRows[0] ?? null;
          if (!savedBlock) throw new Error("Training block write failed");
          await tx.insert(auditLog).values({
            requestId: idempotencyKey,
            actor: actor.id,
            operation: "insert",
            entityType: "training_block",
            entityId: blockId,
            payloadSha256: digest,
          });
        }
        let savedTarget: typeof nutritionSettings.$inferSelect | null = null;
        if (targetValues && targetDigest) {
          const targetRows = await tx
            .insert(nutritionSettings)
            .values(targetValues)
            .returning();
          savedTarget = targetRows[0] ?? null;
          if (!savedTarget) {
            throw new Error("Nutrition target write failed");
          }
          await tx.insert(auditLog).values({
            requestId: idempotencyKey,
            actor: actor.id,
            operation: "insert",
            entityType: "nutrition_target",
            entityId: targetValues.settingsId,
            payloadSha256: targetDigest,
          });
        }
        await tx.insert(auditLog).values({
          requestId: idempotencyKey,
          actor: actor.id,
          operation: "update",
          entityType: "profile",
          entityId: current.profileId,
          payloadSha256: digest,
        });
        return {
          profile: stored,
          nutritionTarget: savedTarget,
          trainingBlock: savedBlock,
        };
      });
      updated = transactionResult.profile;
      storedTarget = transactionResult.nutritionTarget;
    } catch (error) {
      if (!(error instanceof ProfileWriteConflict)) throw error;
      const latest = await firstProfile();
      return apiError(
        "PROFILE_WRITE_CONFLICT",
        409,
        { currentUpdatedAt: latest?.updatedAt ?? null },
        "Profile write conflict",
      );
    }

    const responseDate = dateInTimeZone(new Date(), updated.timezone);
    const responseTarget =
      storedTarget && storedTarget.effectiveFrom <= responseDate
        ? storedTarget
        : await effectiveNutritionTarget(responseDate);
    const responseBlock = await activeTrainingBlock(updated.profileId);
    return Response.json({
      contractVersion: PROFILE_CONTRACT_VERSION,
      profile: profileResponse(updated, responseTarget, responseBlock),
      requestId: idempotencyKey,
    });
  } catch (error) {
    return profileRouteError(error);
  }
}
