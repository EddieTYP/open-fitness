import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  auditLog,
  nutritionEnergyObservations,
} from "@/db/schema";
import {
  getApiActor,
  routeError,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { resolveAutomationActor } from "@/lib/api-auth-policy";
import { apiError } from "@/lib/api-error";
import { appleHealthActiveEnergyObservation } from "@/lib/apple-health-sync";
import { findIdempotentReplay } from "@/lib/idempotency";
import { getNutritionDay } from "@/lib/nutrition";
import { getProfileTimezone } from "@/lib/profile-timezone";
import {
  finiteNumber,
  isDateOnly,
  isIsoTimestamp,
  payloadSha256,
  requestId,
} from "@/lib/record-utils";
import { getRuntimeEnvValue } from "@/lib/runtime-env";
import { dateInTimeZone } from "@/lib/timezone.mjs";

export const dynamic = "force-dynamic";

type EnergyInput = {
  energyObservationId?: string;
  localDate?: string;
  observedAt?: string | null;
  activeEnergyKcal?: number;
  basalEnergyKcal?: number | null;
  status?: "provisional" | "final";
  source?: string;
  note?: string | null;
};

async function storedEnergyLocalDate(energyObservationId: string) {
  const rows = await getDb()
    .select({ localDate: nutritionEnergyObservations.localDate })
    .from(nutritionEnergyObservations)
    .where(
      eq(
        nutritionEnergyObservations.energyObservationId,
        energyObservationId,
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw new Error("Active energy replay is unavailable");
  }
  return rows[0].localDate;
}

async function syncAppleHealthEnergy(payload: unknown, today: string) {
  const observation = await appleHealthActiveEnergyObservation(
    payload,
    today,
  );
  const {
    activeEnergyKcal,
    digest,
    id,
    localDate,
    mode,
    observedAt,
    requestId,
    status,
  } = observation;
  const db = getDb();
  const existing = await db
    .select({
      energyObservationId: nutritionEnergyObservations.energyObservationId,
      localDate: nutritionEnergyObservations.localDate,
      observedAt: nutritionEnergyObservations.observedAt,
      activeEnergyKcal: nutritionEnergyObservations.activeEnergyKcal,
      status: nutritionEnergyObservations.status,
    })
    .from(nutritionEnergyObservations)
    .where(eq(nutritionEnergyObservations.energyObservationId, id))
    .limit(1);
  if (
    existing.length > 0 &&
    (mode === "settlement" ||
      (existing[0].activeEnergyKcal === activeEnergyKcal &&
        existing[0].status === status))
  ) {
    return Response.json(
      { ...existing[0], mode, overwritten: false, replay: true },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const observationWrite = db
    .insert(nutritionEnergyObservations)
    .values({
      energyObservationId: id,
      localDate,
      observedAt,
      activeEnergyKcal,
      basalEnergyKcal: null,
      status,
      source: "Apple Health Shortcut",
      note: null,
      createdBy: "apple-health-shortcut",
    });
  await db.batch([
    mode === "intraday"
      ? observationWrite.onConflictDoUpdate({
          target: nutritionEnergyObservations.energyObservationId,
          set: {
            observedAt,
            activeEnergyKcal,
            status,
            source: "Apple Health Shortcut",
            note: null,
            createdBy: "apple-health-shortcut",
          },
        })
      : observationWrite.onConflictDoNothing(),
    db
      .insert(auditLog)
      .values({
        requestId,
        actor: "apple-health-shortcut",
        operation: mode === "intraday" ? "upsert" : "insert",
        entityType: "nutrition_energy",
        entityId: id,
        // An intraday row is deliberately mutable, so a first-value digest
        // would become misleading after later same-day updates.
        payloadSha256: mode === "intraday" ? null : digest,
      })
      .onConflictDoNothing(),
  ]);

  const saved = await db
    .select({
      energyObservationId: nutritionEnergyObservations.energyObservationId,
      localDate: nutritionEnergyObservations.localDate,
      observedAt: nutritionEnergyObservations.observedAt,
      activeEnergyKcal: nutritionEnergyObservations.activeEnergyKcal,
      status: nutritionEnergyObservations.status,
    })
    .from(nutritionEnergyObservations)
    .where(eq(nutritionEnergyObservations.energyObservationId, id))
    .limit(1);
  if (
    saved.length !== 1 ||
    saved[0].localDate !== localDate ||
    saved[0].observedAt !== observedAt ||
    saved[0].activeEnergyKcal !== activeEnergyKcal ||
    saved[0].status !== status
  ) {
    throw new Error("Apple Health sync read-back mismatch");
  }

  return Response.json(
    {
      ...saved[0],
      mode,
      overwritten: mode === "intraday" && existing.length > 0,
      replay: false,
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  try {
    const actor = await getApiActor(request);
    const healthSyncActor = actor
      ? null
      : resolveAutomationActor(request, {
          apiToken:
            getRuntimeEnvValue("FITNESS_HEALTH_SYNC_TOKEN") ?? undefined,
        });
    if (!actor && !healthSyncActor) return unauthorizedResponse();

    const timezone = await getProfileTimezone();
    const today = dateInTimeZone(new Date(), timezone);
    const payload = await request.json();
    if (healthSyncActor) return await syncAppleHealthEnergy(payload, today);
    if (!actor) return unauthorizedResponse();

    const energyPayload = payload as EnergyInput;
    const localDate = energyPayload.localDate || today;
    if (!isDateOnly(localDate)) {
      return apiError(
        "INVALID_ENERGY_LOCAL_DATE",
        400,
        { field: "localDate" },
        "Invalid energy local date",
      );
    }
    if (
      energyPayload.observedAt !== null &&
      energyPayload.observedAt !== undefined &&
      !isIsoTimestamp(energyPayload.observedAt)
    ) {
      return apiError(
        "INVALID_ENERGY_TIMESTAMP",
        400,
        { field: "observedAt" },
        "Invalid energy timestamp",
      );
    }

    const activeEnergyKcal = finiteNumber(energyPayload.activeEnergyKcal, {
      min: 0,
      max: 10000,
    })!;
    const status =
      energyPayload.status ??
      (localDate === today ? "provisional" : "final");
    if (!["provisional", "final"].includes(status)) {
      return apiError(
        "INVALID_ENERGY_STATUS",
        400,
        { status, allowedStatuses: ["provisional", "final"] },
        "Invalid energy status",
      );
    }

    const observedAt =
      energyPayload.observedAt === undefined
        ? localDate === today
          ? new Date().toISOString()
          : null
        : energyPayload.observedAt;
    const idempotencyKey = requestId(request);
    const digest = await payloadSha256(energyPayload);
    const replayedId = await findIdempotentReplay(
      idempotencyKey,
      "nutrition_energy",
      digest,
    );
    if (replayedId) {
      const replayedLocalDate = await storedEnergyLocalDate(replayedId);
      return Response.json({
        energyObservationId: replayedId,
        requestId: idempotencyKey,
        replay: true,
        nutrition: await getNutritionDay(replayedLocalDate),
      });
    }
    const id =
      energyPayload.energyObservationId?.trim() ||
      `ENERGY|REQUEST|${await payloadSha256(idempotencyKey)}`;

    const db = getDb();
    let writeResult: { energyObservationId: string; replay: boolean };
    try {
      writeResult = await db.transaction(async (tx) => {
        const concurrentReplayId = await findIdempotentReplay(
          idempotencyKey,
          "nutrition_energy",
          digest,
          tx,
        );
        if (concurrentReplayId) {
          return {
            energyObservationId: concurrentReplayId,
            replay: true,
          };
        }
        await tx.insert(nutritionEnergyObservations).values({
          energyObservationId: id,
          localDate,
          observedAt,
          activeEnergyKcal,
          basalEnergyKcal: finiteNumber(energyPayload.basalEnergyKcal, {
            min: 0,
            max: 10000,
            optional: true,
          }),
          status,
          source:
            energyPayload.source?.trim() ||
            (actor.kind === "fitness-agent"
              ? "Open Fitness Agent"
              : "Open Fitness WebApp"),
          note: energyPayload.note?.trim() || null,
          createdBy: actor.id,
        });
        await tx.insert(auditLog).values({
          requestId: idempotencyKey,
          actor: actor.id,
          operation: "insert",
          entityType: "nutrition_energy",
          entityId: id,
          payloadSha256: digest,
        });
        return { energyObservationId: id, replay: false };
      });
    } catch (error) {
      const concurrentReplayId = await findIdempotentReplay(
        idempotencyKey,
        "nutrition_energy",
        digest,
      );
      if (!concurrentReplayId) throw error;
      writeResult = {
        energyObservationId: concurrentReplayId,
        replay: true,
      };
    }

    const storedLocalDate = await storedEnergyLocalDate(
      writeResult.energyObservationId,
    );

    return Response.json(
      {
        energyObservationId: writeResult.energyObservationId,
        requestId: idempotencyKey,
        replay: writeResult.replay,
        nutrition: await getNutritionDay(storedLocalDate),
      },
      { status: writeResult.replay ? 200 : 201 },
    );
  } catch (error) {
    return routeError(error);
  }
}
