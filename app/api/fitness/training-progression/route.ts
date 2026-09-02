import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import { getDb } from "@/db";
import {
  operatingConstraints,
  profile,
  trainingBlocks,
  workoutSessions,
  workoutSets,
} from "@/db/schema";
import {
  getApiActor,
  routeError,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { apiError } from "@/lib/api-error";
import { effectiveOperatingConstraints } from "@/lib/operating-constraint-corrections";
import { exerciseConstraintState } from "@/lib/training-constraints";
import { parseCycle } from "@/lib/training-cycle";
import {
  evaluateTrainingProgression,
  trainingProgressionFingerprint,
} from "@/lib/training-progression";
import { dateInTimeZone } from "@/lib/timezone.mjs";
import { effectiveWorkoutRecords } from "@/lib/workout-corrections";

export const dynamic = "force-dynamic";

const CONTRACT_VERSION = "2026-08-23.1";

export async function GET(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const url = new URL(request.url);
    const unknown = [...url.searchParams.keys()].filter(
      (key) => key !== "phaseId",
    );
    if (unknown.length > 0) {
      return apiError(
        "INVALID_TRAINING_PROGRESSION_QUERY",
        400,
        { unknown },
        "Invalid training progression query",
      );
    }
    const phaseId = url.searchParams.get("phaseId")?.trim();
    if (!phaseId) {
      return apiError(
        "INVALID_TRAINING_PROGRESSION_QUERY",
        400,
        { reason: "phaseId is required" },
        "Invalid training progression query",
      );
    }

    const db = getDb();
    const profiles = await db.select().from(profile).limit(1);
    const currentProfile = profiles[0];
    if (!currentProfile) {
      return apiError("PROFILE_NOT_FOUND", 404, {}, "Profile not found");
    }
    const blocks = await db
      .select()
      .from(trainingBlocks)
      .where(
        and(
          eq(trainingBlocks.profileId, currentProfile.profileId),
          isNull(trainingBlocks.endsOn),
        ),
      )
      .limit(1);
    const block = blocks[0];
    if (!block) {
      return apiError(
        "TRAINING_BLOCK_NOT_FOUND",
        409,
        {},
        "Active training block is unavailable",
      );
    }
    const phase = parseCycle(
      currentProfile.trainingCycle,
      block.trainingCycleSnapshot,
    ).find((candidate) => candidate.id === phaseId);
    if (!phase || phase.kind !== "training") {
      return apiError(
        "TRAINING_PHASE_NOT_FOUND",
        404,
        { phaseId },
        "Training phase not found",
      );
    }

    const rawSessions = await db
      .select()
      .from(workoutSessions)
      .where(
        and(
          eq(workoutSessions.trainingBlockId, block.blockId),
          eq(workoutSessions.trainingPhaseId, phase.id),
          isNull(workoutSessions.voidedAt),
        ),
      )
      .orderBy(
        desc(workoutSessions.startedAtUtc),
        desc(workoutSessions.startedAt),
      );
    const sessionIds = rawSessions.map((session) => session.sessionId);
    const rawSets =
      sessionIds.length > 0
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
    const today = dateInTimeZone(new Date(), currentProfile.timezone);
    const rawConstraints = await db
      .select()
      .from(operatingConstraints)
      .orderBy(desc(operatingConstraints.effectiveDate));
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
    const result = evaluateTrainingProgression({
      phase,
      trainingBlockId: block.blockId,
      sessions: projected.sessions,
      sets: projected.sets,
      constrainedExercises,
    });
    const progressionFingerprint = trainingProgressionFingerprint({
      phase,
      trainingBlockId: block.blockId,
      sessions: projected.sessions,
      sets: projected.sets,
      constrainedExercises,
    });

    return Response.json(
      {
        contractVersion: CONTRACT_VERSION,
        actor: actor.kind,
        trainingBlock: {
          blockId: block.blockId,
          goalType: block.goalType,
          primaryGoal: block.primaryGoal,
          startsOn: block.startsOn,
        },
        phaseId: phase.id,
        progressionFingerprint,
        proposals: result.proposals,
        blocked: result.blocked,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return routeError(error);
  }
}
