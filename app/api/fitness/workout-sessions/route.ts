import { and, eq, isNull, ne } from "drizzle-orm";
import { getDb } from "@/db";
import {
  auditLog,
  profile as fitnessProfile,
  trainingBlocks,
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
import { findIdempotentReplay } from "@/lib/idempotency";
import { payloadSha256 } from "@/lib/record-utils";
import {
  inferSessionTrainingPhaseId,
  parseCycle,
} from "@/lib/training-cycle";
import {
  normaliseWorkoutPayload,
  WorkoutValidationError,
  workoutWriteContract,
  WORKOUT_CONTRACT_VERSION,
} from "@/lib/workout-records";
import { effectiveWorkoutRecords } from "@/lib/workout-corrections";

export const dynamic = "force-dynamic";

function requiredIdempotencyKey(request: Request) {
  const key = request.headers.get("x-idempotency-key")?.trim();
  if (!key) {
    throw new WorkoutValidationError(
      "headers.x-idempotency-key",
      "is required",
    );
  }
  if (key.length > 200) {
    throw new WorkoutValidationError(
      "headers.x-idempotency-key",
      "must not exceed 200 characters",
    );
  }
  return key;
}

type WorkoutRevisionAction = "void" | "restore";

type WorkoutRevisionReceipt = {
  sessionId: string;
  action: WorkoutRevisionAction;
  voidedAt: string | null;
  noOp: boolean;
};

class WorkoutRevisionReplayConflict extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super("Workout session replay is no longer reconstructable");
    this.sessionId = sessionId;
  }
}

function workoutRevisionEntityId(receipt: WorkoutRevisionReceipt) {
  return [
    receipt.sessionId,
    "REVISION",
    receipt.action,
    receipt.noOp ? "NO_OP" : "MUTATION",
    receipt.voidedAt === null ? "NULL" : encodeURIComponent(receipt.voidedAt),
  ].join("|");
}

function workoutRevisionReceiptFromEntityId(
  sessionId: string,
  entityId: string,
): WorkoutRevisionReceipt | null {
  const prefix = `${sessionId}|REVISION|`;
  if (!entityId.startsWith(prefix)) return null;
  const [action, outcome, encodedVoidedAt, ...extra] = entityId
    .slice(prefix.length)
    .split("|");
  if (
    extra.length > 0 ||
    (action !== "void" && action !== "restore") ||
    (outcome !== "NO_OP" && outcome !== "MUTATION") ||
    !encodedVoidedAt
  ) {
    return null;
  }
  let voidedAt: string | null;
  if (encodedVoidedAt === "NULL") {
    voidedAt = null;
  } else {
    try {
      voidedAt = decodeURIComponent(encodedVoidedAt);
    } catch {
      return null;
    }
    if (!voidedAt) return null;
  }
  const noOp = outcome === "NO_OP";
  if ((action === "void" && voidedAt === null) ||
      (action === "restore" && voidedAt !== null)) {
    return null;
  }
  return {
    sessionId,
    action,
    voidedAt,
    noOp,
  };
}

function workoutRevisionResponse(
  receipt: WorkoutRevisionReceipt,
  requestId: string,
  replay: boolean,
) {
  return Response.json({
    contractVersion: WORKOUT_CONTRACT_VERSION,
    sessionId: receipt.sessionId,
    action: receipt.action,
    voidedAt: receipt.voidedAt,
    requestId,
    replay,
    ...(receipt.noOp ? { noOp: true } : {}),
  });
}

function workoutRouteError(error: unknown) {
  if (error instanceof WorkoutValidationError) {
    return apiError(
      "INVALID_WORKOUT_PAYLOAD",
      400,
      { issues: error.issues },
      "Invalid workout payload",
    );
  }
  if (error instanceof WorkoutRevisionReplayConflict) {
    return apiError(
      "WORKOUT_SESSION_REPLAY_CONFLICT",
      409,
      { sessionId: error.sessionId },
      "Workout session replay is no longer reconstructable",
    );
  }
  return routeError(error);
}

function writeSummary(workout: ReturnType<typeof normaliseWorkoutPayload>) {
  return {
    contractVersion: WORKOUT_CONTRACT_VERSION,
    sessionId: workout.sessionId,
    sessionIntent: workout.sessionIntent,
    trainingPhaseId: workout.trainingPhaseId,
    title: workout.sessionTitle,
    type: workout.sessionType,
    startedAt: workout.startedAt,
    startedAtUtc: workout.startedAtUtc,
    localDate: workout.localDate,
    timePrecision: workout.timePrecision,
    durationSeconds: workout.durationSeconds,
    sets: workout.sets.length,
    effortRaw: workout.effortRaw,
    venueManual: workout.venueManual,
  };
}

export async function GET(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId")?.trim();
    if (!sessionId) {
      return Response.json(
        { actor: actor.kind, contract: workoutWriteContract },
        { headers: { "cache-control": "no-store" } },
      );
    }

    const db = getDb();
    const rows = await db
      .select()
      .from(workoutSessions)
      .where(eq(workoutSessions.sessionId, sessionId))
      .limit(1);
    const session = rows[0];
    if (!session) {
      return apiError(
        "WORKOUT_SESSION_NOT_FOUND",
        404,
        { sessionId },
        "Workout session not found",
      );
    }
    const sets = await db
      .select()
      .from(workoutSets)
      .where(eq(workoutSets.sessionId, sessionId))
      .orderBy(workoutSets.setNoSession);
    const projected = await effectiveWorkoutRecords(
      { sessions: [session], sets },
      db,
    );
    return Response.json(
      {
        contractVersion: WORKOUT_CONTRACT_VERSION,
        session: projected.sessions[0],
        sets: projected.sets,
        appliedCorrections: projected.appliedCorrections,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return workoutRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const rawPayload: unknown = await request.json();
    const idempotencyKey = requiredIdempotencyKey(request);
    const searchParams = new URL(request.url).searchParams;
    const unknownQuery = [...searchParams.keys()].filter(
      (key) => key !== "validateOnly",
    );
    if (unknownQuery.length > 0) {
      throw new WorkoutValidationError(
        "query",
        `unknown parameter(s): ${unknownQuery.join(", ")}`,
      );
    }
    const validateOnlyValue = searchParams.get("validateOnly");
    if (validateOnlyValue !== null && validateOnlyValue !== "1") {
      throw new WorkoutValidationError("query.validateOnly", "must equal 1");
    }
    const validateOnly = validateOnlyValue === "1";
    const db = getDb();
    const profiles = await db
      .select({
        profileId: fitnessProfile.profileId,
        trainingCycle: fitnessProfile.trainingCycle,
        trainingCycleConfig: fitnessProfile.trainingCycleConfig,
        timezone: fitnessProfile.timezone,
      })
      .from(fitnessProfile)
      .limit(1);
    const currentProfile = profiles[0];
    if (!currentProfile) {
      throw new Error("Workout profile is unavailable");
    }
    const activeBlocks = await db
      .select({ blockId: trainingBlocks.blockId })
      .from(trainingBlocks)
      .where(
        and(
          eq(trainingBlocks.profileId, currentProfile.profileId),
          isNull(trainingBlocks.endsOn),
        ),
      )
      .limit(1);
    const activeBlock = activeBlocks[0];
    if (!activeBlock) {
      throw new Error("Active training block is unavailable");
    }
    const normalisedWorkout = normaliseWorkoutPayload(rawPayload, {
      idempotencyKey,
      timezone: currentProfile.timezone,
    });
    if (
      normalisedWorkout.trainingBlockId !== null &&
      normalisedWorkout.trainingBlockId !== activeBlock.blockId
    ) {
      throw new WorkoutValidationError(
        "trainingBlockId",
        "must identify the active training block",
      );
    }
    const phases = parseCycle(
      currentProfile.trainingCycle,
      currentProfile.trainingCycleConfig,
    );
    if (
      normalisedWorkout.trainingPhaseId !== null &&
      !phases.some(
        (phase) => phase.id === normalisedWorkout.trainingPhaseId,
      )
    ) {
      throw new WorkoutValidationError(
        "trainingPhaseId",
        "must identify a phase in the current training cycle",
      );
    }
    const workout = {
      ...normalisedWorkout,
      trainingBlockId: activeBlock.blockId,
      trainingPhaseId:
        normalisedWorkout.trainingPhaseId ??
        inferSessionTrainingPhaseId(
          phases,
          normalisedWorkout.sessionTitle,
          normalisedWorkout.sessionType,
        ),
    };
    const conflicts = await db
      .select({ sessionId: workoutSessions.sessionId })
      .from(workoutSessions)
      .where(
        and(
          eq(workoutSessions.startedAtUtc, workout.startedAtUtc),
          isNull(workoutSessions.voidedAt),
        ),
      )
      .limit(1);

    if (validateOnly) {
      return Response.json({
        valid: conflicts.length === 0,
        conflict: conflicts[0] ?? null,
        normalised: writeSummary(workout),
      });
    }

    const digest = await payloadSha256(workout);
    const replayedId = await findIdempotentReplay(
      idempotencyKey,
      "workout_session",
      digest,
    );
    if (replayedId) {
      return Response.json({
        contractVersion: WORKOUT_CONTRACT_VERSION,
        sessionId: replayedId,
        setsInserted: 0,
        requestId: idempotencyKey,
        replay: true,
      });
    }
    if (conflicts.length > 0) {
      return apiError(
        "WORKOUT_SESSION_TIME_CONFLICT",
        409,
        { conflictSessionId: conflicts[0].sessionId },
        "Workout session time conflict",
      );
    }

    const { sets, ...session } = workout;
    const writeOnce = () =>
      db.transaction(async (tx) => {
        const concurrentReplayId = await findIdempotentReplay(
          idempotencyKey,
          "workout_session",
          digest,
          tx,
        );
        if (concurrentReplayId) {
          return { replayedId: concurrentReplayId };
        }

        await tx.insert(workoutSessions).values({
          ...session,
          totalSetsReported: sets.length,
        });
        if (sets.length > 0) await tx.insert(workoutSets).values(sets);
        if (
          workout.sessionIntent === "normal" &&
          workout.trainingPhaseId !== null
        ) {
          await tx
            .update(trainingNextCourseOverrides)
            .set({
              consumedBySessionId: workout.sessionId,
              consumedAt: new Date().toISOString(),
            })
            .where(
              and(
                eq(
                  trainingNextCourseOverrides.profileId,
                  currentProfile.profileId,
                ),
                eq(
                  trainingNextCourseOverrides.trainingBlockId,
                  activeBlock.blockId,
                ),
                eq(
                  trainingNextCourseOverrides.phaseId,
                  workout.trainingPhaseId,
                ),
                isNull(trainingNextCourseOverrides.consumedAt),
                isNull(trainingNextCourseOverrides.voidedAt),
              ),
            );
        }
        if (
          workout.sessionIntent !== "normal" &&
          workout.trainingPhaseId !== null
        ) {
          await tx
            .update(trainingPlannedSessions)
            .set({
              consumedBySessionId: workout.sessionId,
              consumedAt: new Date().toISOString(),
            })
            .where(
              and(
                eq(trainingPlannedSessions.profileId, currentProfile.profileId),
                eq(trainingPlannedSessions.trainingBlockId, activeBlock.blockId),
                eq(trainingPlannedSessions.phaseId, workout.trainingPhaseId),
                eq(trainingPlannedSessions.localDate, workout.localDate),
                eq(trainingPlannedSessions.sessionIntent, workout.sessionIntent),
                isNull(trainingPlannedSessions.consumedAt),
                isNull(trainingPlannedSessions.voidedAt),
              ),
            );
        }
        await tx.insert(auditLog).values({
          requestId: idempotencyKey,
          actor: actor.id,
          operation: "insert",
          entityType: "workout_session",
          entityId: workout.sessionId,
          payloadSha256: digest,
        });
        return { replayedId: null };
      });
    let writeResult: { replayedId: string | null };
    for (let attempt = 0; ; attempt += 1) {
      try {
        writeResult = await writeOnce();
        break;
      } catch (error) {
        const sqliteCode =
          typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : "";
        if (attempt === 0 && sqliteCode.startsWith("SQLITE_BUSY")) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          continue;
        }
        const concurrentReplayId = await findIdempotentReplay(
          idempotencyKey,
          "workout_session",
          digest,
        );
        if (concurrentReplayId) {
          writeResult = { replayedId: concurrentReplayId };
          break;
        }
        throw error;
      }
    }

    if (writeResult.replayedId) {
      return Response.json({
        contractVersion: WORKOUT_CONTRACT_VERSION,
        sessionId: writeResult.replayedId,
        setsInserted: 0,
        requestId: idempotencyKey,
        replay: true,
      });
    }

    return Response.json(
      {
        ...writeSummary(workout),
        setsInserted: sets.length,
        requestId: idempotencyKey,
        replay: false,
      },
      { status: 201 },
    );
  } catch (error) {
    return workoutRouteError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const payload: unknown = await request.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Invalid workout revision: expected an object");
    }
    const value = payload as Record<string, unknown>;
    const unknown = Object.keys(value).filter(
      (key) => !["action", "sessionId", "reason"].includes(key),
    );
    if (unknown.length > 0) {
      throw new Error(`Invalid workout revision field(s): ${unknown.join(", ")}`);
    }
    const action = value.action;
    const sessionId =
      typeof value.sessionId === "string" ? value.sessionId.trim() : "";
    const reason = typeof value.reason === "string" ? value.reason.trim() : "";
    if ((action !== "void" && action !== "restore") || !sessionId || !reason) {
      throw new Error("Invalid workout revision: action, sessionId and reason are required");
    }
    const idempotencyKey = requiredIdempotencyKey(request);
    const digest = await payloadSha256(payload);
    const db = getDb();
    const result = await db.transaction(async (tx) => {
      const replayedId = await findIdempotentReplay(
        idempotencyKey,
        "workout_session",
        digest,
        tx,
      );
      if (replayedId) {
        const receipt = workoutRevisionReceiptFromEntityId(
          sessionId,
          replayedId,
        );
        if (!receipt || receipt.action !== action) {
          throw new WorkoutRevisionReplayConflict(sessionId);
        }
        return { kind: "replay" as const, receipt };
      }

      const rows = await tx
        .select()
        .from(workoutSessions)
        .where(eq(workoutSessions.sessionId, sessionId))
        .limit(1);
      const session = rows[0];
      if (!session) return { kind: "missing" as const };

      const noOp =
        (action === "void" && session.voidedAt !== null) ||
        (action === "restore" && session.voidedAt === null);
      if (action === "restore" && !noOp && session.startedAtUtc !== null) {
        const conflicts = await tx
          .select({ sessionId: workoutSessions.sessionId })
          .from(workoutSessions)
          .where(
            and(
              eq(workoutSessions.startedAtUtc, session.startedAtUtc),
              isNull(workoutSessions.voidedAt),
              ne(workoutSessions.sessionId, sessionId),
            ),
          )
          .limit(1);
        if (conflicts.length > 0) {
          return {
            kind: "restoreConflict" as const,
            conflictSessionId: conflicts[0].sessionId,
          };
        }
      }

      const now = new Date().toISOString();
      let voidedAt = noOp
        ? session.voidedAt
        : action === "void"
          ? now
          : null;
      if (!noOp) {
        const updatedRows = await tx
          .update(workoutSessions)
          .set(
            action === "void"
              ? { voidedAt: now, voidReason: reason, voidedBy: actor.id }
              : { voidedAt: null, voidReason: null, voidedBy: null },
          )
          .where(eq(workoutSessions.sessionId, sessionId))
          .returning({ voidedAt: workoutSessions.voidedAt });
        if (!updatedRows[0]) {
          throw new WorkoutRevisionReplayConflict(sessionId);
        }
        voidedAt = updatedRows[0].voidedAt;
      }

      const receipt = {
        sessionId,
        action,
        voidedAt,
        noOp,
      } satisfies WorkoutRevisionReceipt;
      await tx.insert(auditLog).values({
        requestId: idempotencyKey,
        actor: actor.id,
        operation: action,
        entityType: "workout_session",
        entityId: workoutRevisionEntityId(receipt),
        payloadSha256: digest,
      });
      return { kind: "stored" as const, receipt };
    });

    if (result.kind === "missing") {
      return apiError(
        "WORKOUT_SESSION_NOT_FOUND",
        404,
        { sessionId },
        "Workout session not found",
      );
    }
    if (result.kind === "restoreConflict") {
      return apiError(
        "WORKOUT_SESSION_RESTORE_CONFLICT",
        409,
        { conflictSessionId: result.conflictSessionId },
        "Workout session restore conflict",
      );
    }
    return workoutRevisionResponse(
      result.receipt,
      idempotencyKey,
      result.kind === "replay",
    );
  } catch (error) {
    return workoutRouteError(error);
  }
}
