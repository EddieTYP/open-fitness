import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  auditLog,
  profile,
  trainingScheduleEvents,
} from "@/db/schema";
import {
  getApiActor,
  routeError,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { apiError } from "@/lib/api-error";
import { findIdempotentReplay } from "@/lib/idempotency";
import { payloadSha256 } from "@/lib/record-utils";
import { parseCycle } from "@/lib/training-cycle";
import {
  deriveTrainingSchedule,
  normaliseTrainingScheduleMutation,
  normaliseTrainingScheduleRevision,
  TRAINING_SCHEDULE_CONTRACT_VERSION,
  trainingScheduleContract,
  TrainingScheduleValidationError,
} from "@/lib/training-schedule";
import { dateInTimeZone } from "@/lib/timezone.mjs";

export const dynamic = "force-dynamic";

function requiredIdempotencyKey(request: Request) {
  const key = request.headers.get("x-idempotency-key")?.trim();
  if (!key) {
    throw new TrainingScheduleValidationError(
      "headers.x-idempotency-key is required",
    );
  }
  if (key.length > 200) {
    throw new TrainingScheduleValidationError(
      "headers.x-idempotency-key must not exceed 200 characters",
    );
  }
  return key;
}

function scheduleRouteError(error: unknown) {
  if (error instanceof TrainingScheduleValidationError) {
    return apiError(
      "INVALID_TRAINING_SCHEDULE_PAYLOAD",
      400,
      { reason: error.message },
      "Invalid training schedule payload",
    );
  }
  return routeError(error);
}

async function profileContext(planningDate?: string) {
  const db = getDb();
  const profiles = await db.select().from(profile).limit(1);
  const currentProfile = profiles[0];
  if (!currentProfile) {
    throw new Error("Training schedule profile is unavailable");
  }
  const effectivePlanningDate =
    planningDate ?? dateInTimeZone(new Date(), currentProfile.timezone);
  const events = await db
    .select()
    .from(trainingScheduleEvents)
    .where(eq(trainingScheduleEvents.profileId, currentProfile.profileId))
    .orderBy(
      asc(trainingScheduleEvents.effectiveDate),
      asc(trainingScheduleEvents.recordedAt),
      asc(trainingScheduleEvents.eventId),
    );
  return {
    profile: currentProfile,
    events,
    planningDate: effectivePlanningDate,
    schedule: deriveTrainingSchedule(events, effectivePlanningDate),
  };
}

function eventSummary(event: typeof trainingScheduleEvents.$inferSelect) {
  return {
    eventId: event.eventId,
    profileId: event.profileId,
    effectiveDate: event.effectiveDate,
    eventType: event.eventType,
    resumeOn: event.resumeOn,
    reason: event.reason,
    recordedAt: event.recordedAt,
    voidedAt: event.voidedAt,
  };
}

async function eventById(eventId: string) {
  const rows = await getDb()
    .select()
    .from(trainingScheduleEvents)
    .where(eq(trainingScheduleEvents.eventId, eventId))
    .limit(1);
  return rows[0] ?? null;
}

export async function GET(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const context = await profileContext();
    return Response.json(
      {
        actor: actor.kind,
        contract: trainingScheduleContract,
        planningDate: context.planningDate,
        cycle: parseCycle(
          context.profile.trainingCycle,
          context.profile.trainingCycleConfig,
        ),
        schedule: {
          status: context.schedule.status,
          pause: context.schedule.pause,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return scheduleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const rawPayload: unknown = await request.json();
    const mutation = normaliseTrainingScheduleMutation(rawPayload);
    const idempotencyKey = requiredIdempotencyKey(request);
    const digest = await payloadSha256(mutation);
    const replayedId = await findIdempotentReplay(
      idempotencyKey,
      "training_schedule_event",
      digest,
    );
    if (replayedId) {
      const replayedEvent = await eventById(replayedId);
      if (!replayedEvent) {
        throw new Error("Training schedule replay event is unavailable");
      }
      return Response.json({
        contractVersion: TRAINING_SCHEDULE_CONTRACT_VERSION,
        event: eventSummary(replayedEvent),
        requestId: idempotencyKey,
        replay: true,
      });
    }

    const context = await profileContext(mutation.effectiveDate);
    if (mutation.action === "pause" && context.schedule.status === "paused") {
      return apiError(
        "TRAINING_SCHEDULE_ALREADY_PAUSED",
        409,
        { status: context.schedule.status },
        "Training schedule is already paused",
      );
    }
    if (mutation.action === "resume" && context.schedule.status !== "paused") {
      return apiError(
        "TRAINING_SCHEDULE_NOT_PAUSED",
        409,
        { status: context.schedule.status },
        "Training schedule is not paused",
      );
    }

    const eventId = `TRAINING-SCHEDULE|${crypto.randomUUID()}`;
    const recordedAt = new Date().toISOString();
    const event = {
      eventId,
      profileId: context.profile.profileId,
      effectiveDate: mutation.effectiveDate,
      eventType: mutation.action,
      resumeOn: mutation.resumeOn,
      reason: mutation.reason,
      recordedAt,
      createdBy: actor.id,
    } as const;
    const db = getDb();
    await db.batch([
      db.insert(trainingScheduleEvents).values(event),
      db.insert(auditLog).values({
        requestId: idempotencyKey,
        actor: actor.id,
        operation: "insert",
        entityType: "training_schedule_event",
        entityId: eventId,
        payloadSha256: digest,
      }),
    ]);

    const stored = await eventById(eventId);
    if (
      !stored ||
      stored.profileId !== event.profileId ||
      stored.effectiveDate !== event.effectiveDate ||
      stored.eventType !== event.eventType ||
      stored.resumeOn !== event.resumeOn ||
      stored.reason !== event.reason ||
      stored.recordedAt !== event.recordedAt ||
      stored.createdBy !== event.createdBy ||
      stored.voidedAt !== null
    ) {
      throw new Error("Training schedule event readback mismatch");
    }

    return Response.json(
      {
        contractVersion: TRAINING_SCHEDULE_CONTRACT_VERSION,
        event: eventSummary(stored),
        requestId: idempotencyKey,
      },
      { status: 201 },
    );
  } catch (error) {
    return scheduleRouteError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const rawPayload: unknown = await request.json();
    const revision = normaliseTrainingScheduleRevision(rawPayload);
    const idempotencyKey = requiredIdempotencyKey(request);
    const digest = await payloadSha256(revision);
    const replayedId = await findIdempotentReplay(
      idempotencyKey,
      "training_schedule_event",
      digest,
    );
    if (replayedId) {
      const replayedEvent = await eventById(replayedId);
      if (!replayedEvent) {
        throw new Error("Training schedule replay event is unavailable");
      }
      return Response.json({
        contractVersion: TRAINING_SCHEDULE_CONTRACT_VERSION,
        event: eventSummary(replayedEvent),
        action: revision.action,
        replay: true,
      });
    }

    const existing = await eventById(revision.eventId);
    if (!existing) {
      return apiError(
        "TRAINING_SCHEDULE_EVENT_NOT_FOUND",
        404,
        { eventId: revision.eventId },
        "Training schedule event not found",
      );
    }
    const noOp =
      (revision.action === "void" && existing.voidedAt !== null) ||
      (revision.action === "restore" && existing.voidedAt === null);
    const db = getDb();
    const now = new Date().toISOString();
    const audit = db.insert(auditLog).values({
      requestId: idempotencyKey,
      actor: actor.id,
      operation: revision.action,
      entityType: "training_schedule_event",
      entityId: revision.eventId,
      payloadSha256: digest,
    });
    if (noOp) {
      await audit;
    } else {
      await db.batch([
        db
          .update(trainingScheduleEvents)
          .set(
            revision.action === "void"
              ? {
                  voidedAt: now,
                  voidReason: revision.reason,
                  voidedBy: actor.id,
                }
              : { voidedAt: null, voidReason: null, voidedBy: null },
          )
          .where(eq(trainingScheduleEvents.eventId, revision.eventId)),
        audit,
      ]);
    }

    const stored = await eventById(revision.eventId);
    const expectedVoided =
      revision.action === "void" ? existing.voidedAt ?? now : null;
    if (!stored || stored.voidedAt !== expectedVoided) {
      throw new Error("Training schedule revision readback mismatch");
    }
    return Response.json({
      contractVersion: TRAINING_SCHEDULE_CONTRACT_VERSION,
      event: eventSummary(stored),
      action: revision.action,
      noOp,
    });
  } catch (error) {
    return scheduleRouteError(error);
  }
}
