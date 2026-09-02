import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { getDb } from "@/db";
import {
  auditLog,
  profile,
  trainingExerciseSelections,
  workoutSessions,
  workoutSets,
} from "@/db/schema";
import {
  getApiActor,
  routeError,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { apiError } from "@/lib/api-error";
import { findIdempotentReplay } from "@/lib/idempotency";
import {
  buildExerciseSuggestions,
  canonicalExerciseUsedAt,
} from "@/lib/exercise-suggestions";
import { getDashboardData } from "@/lib/fitness";
import { nextProfileUpdatedAt, profileResponse } from "@/lib/profile-settings";
import { payloadSha256 } from "@/lib/record-utils";
import {
  allowedExercise,
  isCurrentDateSelectionTarget,
  isHistoryExerciseSlotId,
  normaliseTrainingExerciseSelection,
  replacePreferredExercise,
  routineSlot,
  TrainingSelectionValidationError,
  venueSelectionKey,
} from "@/lib/training-selections";
import {
  effectiveTrainingCycleConfig,
  inferSessionTrainingPhaseId,
  parseCycle,
} from "@/lib/training-cycle";
import { effectiveWorkoutRecords } from "@/lib/workout-corrections";

export const dynamic = "force-dynamic";

const CONTRACT_VERSION = "2026-08-11.1";
const HISTORY_SET_LIMIT = 2_000;
const STABLE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const historyStartedAt = sql<number>`coalesce(
  julianday(${workoutSessions.startedAtUtc}),
  julianday(${workoutSessions.startedAt})
)`;

class TrainingSelectionConflict extends Error {}

function requiredIdempotencyKey(request: Request) {
  const key = request.headers.get("x-idempotency-key")?.trim();
  if (!key) {
    throw new TrainingSelectionValidationError(
      "headers.x-idempotency-key is required",
    );
  }
  if (key.length > 200) {
    throw new TrainingSelectionValidationError(
      "headers.x-idempotency-key must not exceed 200 characters",
    );
  }
  return key;
}

async function currentProfile() {
  const rows = await getDb().select().from(profile).limit(1);
  return rows[0] ?? null;
}

async function selectionById(selectionId: string) {
  const rows = await getDb()
    .select()
    .from(trainingExerciseSelections)
    .where(eq(trainingExerciseSelections.selectionId, selectionId))
    .limit(1);
  return rows[0] ?? null;
}

function selectionResponse(row: typeof trainingExerciseSelections.$inferSelect) {
  return {
    selectionId: row.selectionId,
    phaseId: row.phaseId,
    slotId: row.slotId,
    scope: row.scope,
    scopeValue: row.scopeValue,
    exercise: row.exercise,
    recordedAt: row.recordedAt,
  };
}

function selectionRouteError(error: unknown) {
  if (error instanceof TrainingSelectionValidationError) {
    return apiError(
      "INVALID_TRAINING_SELECTION",
      400,
      { reason: error.message },
      "Invalid training selection",
    );
  }
  if (error instanceof TrainingSelectionConflict) {
    return apiError(
      "TRAINING_SELECTION_CONFLICT",
      409,
      {},
      "Training selection conflict",
    );
  }
  return routeError(error);
}

function exerciseRequestContext(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = params.get("q") ?? "";
  if (query.length > 120 || /[\u0000-\u001f\u007f]/.test(query)) {
    throw new TrainingSelectionValidationError(
      "q must be a single-line string of at most 120 characters",
    );
  }
  const phaseId = params.get("phaseId")?.trim() || null;
  const slotId = params.get("slotId")?.trim() || null;
  if (
    (phaseId && !STABLE_ID.test(phaseId)) ||
    (slotId && !STABLE_ID.test(slotId))
  ) {
    throw new TrainingSelectionValidationError(
      "phaseId and slotId must be lowercase stable identifiers",
    );
  }
  if (slotId && !phaseId) {
    throw new TrainingSelectionValidationError(
      "phaseId is required when slotId is provided",
    );
  }
  return { query: query.trim(), phaseId, slotId };
}

export async function GET(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const context = exerciseRequestContext(request);
    const storedProfile = await currentProfile();
    if (!storedProfile) {
      return apiError("PROFILE_NOT_FOUND", 404, {}, "Profile not found");
    }
    const config = effectiveTrainingCycleConfig(
      storedProfile.trainingCycle,
      storedProfile.trainingCycleConfig,
    );
    if (
      context.phaseId &&
      !config.phases.some((phase) => phase.id === context.phaseId)
    ) {
      throw new TrainingSelectionValidationError(
        "The selected training phase no longer exists",
      );
    }
    const cyclePhases = parseCycle(
      storedProfile.trainingCycle,
      storedProfile.trainingCycleConfig,
    );
    const db = getDb();
    const [selectionRows, rawHistoryRows] = await Promise.all([
      db
        .select({
          exercise: trainingExerciseSelections.exercise,
          recordedAt: trainingExerciseSelections.recordedAt,
          phaseId: trainingExerciseSelections.phaseId,
          slotId: trainingExerciseSelections.slotId,
        })
        .from(trainingExerciseSelections)
        .where(eq(trainingExerciseSelections.profileId, storedProfile.profileId))
        .orderBy(
          desc(trainingExerciseSelections.recordedAt),
          desc(trainingExerciseSelections.selectionId),
        )
        .limit(500),
      db
        .select({
          setId: workoutSets.setId,
          sessionId: workoutSets.sessionId,
          exercise: workoutSets.exercise,
          trainingPhaseId: workoutSessions.trainingPhaseId,
          sessionTitle: workoutSessions.sessionTitle,
          sessionType: workoutSessions.sessionType,
          startedAt: workoutSessions.startedAt,
          startedAtUtc: workoutSessions.startedAtUtc,
        })
        .from(workoutSets)
        .innerJoin(
          workoutSessions,
          eq(workoutSets.sessionId, workoutSessions.sessionId),
        )
        .where(
          and(
            eq(workoutSessions.sessionType, "Strength"),
            isNull(workoutSessions.voidedAt),
          ),
        )
        .orderBy(
          desc(historyStartedAt),
          desc(workoutSets.setNoSession),
        )
        .limit(HISTORY_SET_LIMIT),
    ]);
    const rawHistorySessions = [
      ...new Map(
        rawHistoryRows.map((row) => [
          row.sessionId,
          {
            sessionId: row.sessionId,
            trainingPhaseId: row.trainingPhaseId,
            sessionTitle: row.sessionTitle,
            sessionType: row.sessionType,
          },
        ]),
      ).values(),
    ];
    const effectiveHistory = await effectiveWorkoutRecords(
      {
        sessions: rawHistorySessions,
        sets: rawHistoryRows.map((row) => ({
          setId: row.setId,
          sessionId: row.sessionId,
          exercise: row.exercise,
        })),
      },
      db,
    );
    const usedAtBySetId = new Map(
      rawHistoryRows.map((row) => [
        row.setId,
        canonicalExerciseUsedAt(row.startedAtUtc, row.startedAt),
      ] as const),
    );
    const historySessionById = new Map(
      effectiveHistory.sessions.map((session) => [session.sessionId, session]),
    );
    const items = buildExerciseSuggestions({
      config,
      selections: selectionRows,
      history: effectiveHistory.sets.map((set) => ({
        exercise: set.exercise,
        usedAt: usedAtBySetId.get(set.setId) ?? "",
        sessionId: set.sessionId,
        phaseId: (() => {
          const session = historySessionById.get(set.sessionId);
          return (
            session?.trainingPhaseId ??
            inferSessionTrainingPhaseId(
              cyclePhases,
              session?.sessionTitle,
              session?.sessionType,
            )
          );
        })(),
      })),
      targetPhaseId: context.phaseId,
      targetSlotId: context.slotId,
      query: context.query,
    });
    return Response.json(
      { contractVersion: CONTRACT_VERSION, items },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return selectionRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const mutation = normaliseTrainingExerciseSelection(await request.json());
    const requestId = requiredIdempotencyKey(request);
    const digest = await payloadSha256(mutation);
    const entityType =
      mutation.scope === "template"
        ? "training_routine_template"
        : "training_exercise_selection";
    const replayedId = await findIdempotentReplay(
      requestId,
      entityType,
      digest,
    );
    if (replayedId) {
      if (mutation.scope === "template") {
        const replayedProfile = await currentProfile();
        if (!replayedProfile || replayedProfile.profileId !== replayedId) {
          throw new Error("Training template replay is unavailable");
        }
        return Response.json({
          contractVersion: CONTRACT_VERSION,
          scope: "template",
          exercise: mutation.exercise,
          profile: profileResponse(replayedProfile),
          requestId,
          replay: true,
        });
      }
      const replayedSelection = await selectionById(replayedId);
      if (!replayedSelection) {
        throw new Error("Training selection replay is unavailable");
      }
      return Response.json({
        contractVersion: CONTRACT_VERSION,
        selection: selectionResponse(replayedSelection),
        requestId,
        replay: true,
      });
    }

    const storedProfile = await currentProfile();
    if (!storedProfile) {
      return apiError("PROFILE_NOT_FOUND", 404, {}, "Profile not found");
    }
    const config = effectiveTrainingCycleConfig(
      storedProfile.trainingCycle,
      storedProfile.trainingCycleConfig,
    );
    const phase = config.phases.find(
      (candidate) => candidate.id === mutation.phaseId,
    );
    if (!phase) {
      throw new TrainingSelectionValidationError(
        "The selected training phase no longer exists",
      );
    }
    let exercise: string | undefined;
    if (mutation.scope === "date") {
      const configuredSlot = phase.routine?.find(
        (candidate) => candidate.id === mutation.slotId,
      );
      if (
        !configuredSlot &&
        (phase.routine?.length || !isHistoryExerciseSlotId(mutation.slotId))
      ) {
        throw new TrainingSelectionValidationError(
          "The selected routine item is not available for a one-workout change",
        );
      }
      const dashboard = await getDashboardData();
      if (dashboard.status === "unavailable") {
        throw new Error("Current training plan is unavailable");
      }
      if (
        !isCurrentDateSelectionTarget({
          plan: dashboard.todayPlan,
          date: mutation.date!,
          phaseId: mutation.phaseId,
          slotId: mutation.slotId,
        })
      ) {
        throw new TrainingSelectionValidationError(
          "The selected routine item is not in the current plan; refresh and try again",
        );
      }
      exercise = mutation.exercise;
    } else {
      const slot = routineSlot(config, mutation.phaseId, mutation.slotId);
      exercise = allowedExercise(slot, mutation.exercise);
    }
    if (!exercise) {
      throw new TrainingSelectionValidationError(
        "venue and template selections require a configured exercise",
      );
    }

    if (mutation.scope === "template") {
      const nextConfig = replacePreferredExercise(
        config,
        mutation.phaseId,
        mutation.slotId,
        exercise,
      );
      const updatedAt = nextProfileUpdatedAt(storedProfile.updatedAt);
      let writeResult:
        | { replay: false; updatedAt: string }
        | { replay: true; profileId: string };
      try {
        writeResult = await getDb().transaction(async (tx) => {
          const concurrentReplayId = await findIdempotentReplay(
            requestId,
            entityType,
            digest,
            tx,
          );
          if (concurrentReplayId) {
            if (concurrentReplayId !== storedProfile.profileId) {
              throw new Error("Training template replay is unavailable");
            }
            return { profileId: concurrentReplayId, replay: true } as const;
          }
          if (storedProfile.updatedAt !== mutation.expectedUpdatedAt) {
            throw new TrainingSelectionConflict();
          }
          const rows = await tx
            .update(profile)
            .set({
              trainingCycleConfig: JSON.stringify(nextConfig),
              trainingCycle: nextConfig.phases
                .map((phase) => phase.label)
                .join(" / "),
              updatedAt,
            })
            .where(
              and(
                eq(profile.profileId, storedProfile.profileId),
                eq(profile.updatedAt, mutation.expectedUpdatedAt!),
              ),
            )
            .returning();
          if (!rows[0]) throw new TrainingSelectionConflict();
          await tx.insert(auditLog).values({
            requestId,
            actor: actor.id,
            operation: "update",
            entityType,
            entityId: storedProfile.profileId,
            payloadSha256: digest,
          });
          return { updatedAt: rows[0].updatedAt, replay: false } as const;
        });
      } catch (error) {
        const racedReplayId = await findIdempotentReplay(
          requestId,
          entityType,
          digest,
        );
        if (!racedReplayId || racedReplayId !== storedProfile.profileId) {
          throw error;
        }
        writeResult = { profileId: racedReplayId, replay: true };
      }
      const readback = await currentProfile();
      if (
        !readback ||
        (writeResult.replay
          ? readback.profileId !== writeResult.profileId
          : readback.updatedAt !== writeResult.updatedAt)
      ) {
        throw new Error("Training template readback mismatch");
      }
      return Response.json(
        {
          contractVersion: CONTRACT_VERSION,
          scope: "template",
          exercise,
          profile: profileResponse(readback),
          requestId,
          replay: writeResult.replay,
        },
        { status: writeResult.replay ? 200 : 201 },
      );
    }

    const selectionId = `TRAINING-SELECTION|${await payloadSha256({
      requestId,
      entityType,
    })}`;
    const recordedAt = new Date().toISOString();
    const scopeValue =
      mutation.scope === "date"
        ? mutation.date!
        : venueSelectionKey(mutation.venue!);
    const selection = {
      selectionId,
      profileId: storedProfile.profileId,
      phaseId: mutation.phaseId,
      slotId: mutation.slotId,
      scope: mutation.scope,
      scopeValue,
      exercise,
      recordedAt,
      createdBy: actor.id,
    } as const;
    const db = getDb();
    let writeResult: { selectionId: string; replay: boolean };
    try {
      writeResult = await db.transaction(async (tx) => {
        const concurrentReplayId = await findIdempotentReplay(
          requestId,
          entityType,
          digest,
          tx,
        );
        if (concurrentReplayId) {
          return { selectionId: concurrentReplayId, replay: true };
        }
        await tx.insert(trainingExerciseSelections).values(selection);
        await tx.insert(auditLog).values({
          requestId,
          actor: actor.id,
          operation: "insert",
          entityType,
          entityId: selectionId,
          payloadSha256: digest,
        });
        return { selectionId, replay: false };
      });
    } catch (error) {
      const concurrentReplayId = await findIdempotentReplay(
        requestId,
        entityType,
        digest,
      );
      if (!concurrentReplayId) throw error;
      writeResult = { selectionId: concurrentReplayId, replay: true };
    }
    const readback = await selectionById(writeResult.selectionId);
    if (
      !readback ||
      (!writeResult.replay &&
        (readback.profileId !== selection.profileId ||
          readback.phaseId !== selection.phaseId ||
          readback.slotId !== selection.slotId ||
          readback.scope !== selection.scope ||
          readback.scopeValue !== selection.scopeValue ||
          readback.exercise !== selection.exercise ||
          readback.recordedAt !== selection.recordedAt ||
          readback.createdBy !== selection.createdBy))
    ) {
      throw new Error("Training selection readback mismatch");
    }
    return Response.json(
      {
        contractVersion: CONTRACT_VERSION,
        selection: selectionResponse(readback),
        requestId,
        replay: writeResult.replay,
      },
      { status: writeResult.replay ? 200 : 201 },
    );
  } catch (error) {
    return selectionRouteError(error);
  }
}
