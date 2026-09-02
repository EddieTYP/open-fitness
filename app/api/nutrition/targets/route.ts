import { and, desc, eq, lte, ne } from "drizzle-orm";

import { getDb } from "@/db";
import { auditLog, nutritionSettings } from "@/db/schema";
import {
  getApiActor,
  routeError,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { apiError } from "@/lib/api-error";
import { findIdempotentReplay } from "@/lib/idempotency";
import {
  assertExpectedNutritionTarget,
  normaliseNutritionTarget,
  NUTRITION_TARGET_CONTRACT_VERSION,
  nutritionTargetInsertValues,
  nutritionTargetResponse,
  NutritionTargetConflictError,
  NutritionTargetValidationError,
} from "@/lib/nutrition-targets";
import { getProfileTimezone } from "@/lib/profile-timezone";
import { isDateOnly, payloadSha256 } from "@/lib/record-utils";
import { dateInTimeZone } from "@/lib/timezone.mjs";

export const dynamic = "force-dynamic";

function noStore(response: Response) {
  response.headers.set("cache-control", "no-store");
  return response;
}

function requiredIdempotencyKey(request: Request) {
  const key = request.headers.get("x-idempotency-key")?.trim();
  if (!key) {
    throw new NutritionTargetValidationError(
      "headers.x-idempotency-key is required",
    );
  }
  if (key.length > 200) {
    throw new NutritionTargetValidationError(
      "headers.x-idempotency-key must not exceed 200 characters",
    );
  }
  return key;
}

function targetRouteError(error: unknown) {
  if (error instanceof NutritionTargetConflictError) {
    return noStore(
      apiError(
        "NUTRITION_TARGET_CONFLICT",
        409,
        { reason: error.message },
        "Nutrition target changed; review the current target",
      ),
    );
  }
  if (error instanceof NutritionTargetValidationError) {
    return noStore(
      apiError(
        "INVALID_NUTRITION_TARGET",
        400,
        { reason: error.message },
        "Invalid nutrition target",
      ),
    );
  }
  return noStore(routeError(error));
}

async function targetById(settingsId: string) {
  const rows = await getDb()
    .select()
    .from(nutritionSettings)
    .where(eq(nutritionSettings.settingsId, settingsId))
    .limit(1);
  return rows[0] ?? null;
}

async function targetRows() {
  return getDb()
    .select()
    .from(nutritionSettings)
    .orderBy(
      desc(nutritionSettings.effectiveFrom),
      desc(nutritionSettings.createdAt),
      desc(nutritionSettings.settingsId),
    );
}

async function effectiveTarget(effectiveDate: string) {
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
    if (!actor) return noStore(unauthorizedResponse());

    const timezone = await getProfileTimezone();
    const requestedDate =
      new URL(request.url).searchParams.get("date") ??
      dateInTimeZone(new Date(), timezone);
    if (!isDateOnly(requestedDate)) {
      throw new NutritionTargetValidationError(
        "date must use YYYY-MM-DD",
      );
    }
    const [rows, current] = await Promise.all([
      targetRows(),
      effectiveTarget(requestedDate),
    ]);
    return noStore(
      Response.json({
        contractVersion: NUTRITION_TARGET_CONTRACT_VERSION,
        actor: actor.kind,
        effectiveDate: requestedDate,
        currentTarget: current ? nutritionTargetResponse(current) : null,
        targets: rows.map(nutritionTargetResponse),
      }),
    );
  } catch (error) {
    return targetRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return noStore(unauthorizedResponse());

    const target = normaliseNutritionTarget(await request.json());
    const idempotencyKey = requiredIdempotencyKey(request);
    const digest = await payloadSha256(target);
    const replayedId = await findIdempotentReplay(
      idempotencyKey,
      "nutrition_target",
      digest,
    );
    if (replayedId) {
      const replayedTarget = await targetById(replayedId);
      if (!replayedTarget) {
        throw new Error("Nutrition target replay is unavailable");
      }
      return noStore(
        Response.json({
          contractVersion: NUTRITION_TARGET_CONTRACT_VERSION,
          target: nutritionTargetResponse(replayedTarget),
          requestId: idempotencyKey,
          replay: true,
        }),
      );
    }

    const db = getDb();
    const settingsId = `NUTRITION-TARGET|REQUEST|${await payloadSha256(
      idempotencyKey,
    )}`;
    let writeResult: {
      settingsId: string;
      replay: boolean;
      values: ReturnType<typeof nutritionTargetInsertValues> | null;
    };
    try {
      writeResult = await db.transaction(async (tx) => {
        const concurrentReplayId = await findIdempotentReplay(
          idempotencyKey,
          "nutrition_target",
          digest,
          tx,
        );
        if (concurrentReplayId) {
          return {
            settingsId: concurrentReplayId,
            replay: true,
            values: null,
          };
        }

        const inheritedRows = await tx
          .select()
          .from(nutritionSettings)
          .where(
            and(
              lte(nutritionSettings.effectiveFrom, target.effectiveFrom),
              ne(nutritionSettings.status, "retired"),
            ),
          )
          .orderBy(
            desc(nutritionSettings.effectiveFrom),
            desc(nutritionSettings.createdAt),
            desc(nutritionSettings.settingsId),
          )
          .limit(1);
        const inherited = inheritedRows[0] ?? null;
        assertExpectedNutritionTarget(target, inherited);
        const values = nutritionTargetInsertValues(
          target,
          inherited,
          settingsId,
        );
        await tx.insert(nutritionSettings).values(values);
        await tx.insert(auditLog).values({
          requestId: idempotencyKey,
          actor: actor.id,
          operation: "insert",
          entityType: "nutrition_target",
          entityId: values.settingsId,
          payloadSha256: digest,
        });
        return { settingsId: values.settingsId, replay: false, values };
      });
    } catch (error) {
      const concurrentReplayId = await findIdempotentReplay(
        idempotencyKey,
        "nutrition_target",
        digest,
      );
      if (!concurrentReplayId) throw error;
      writeResult = {
        settingsId: concurrentReplayId,
        replay: true,
        values: null,
      };
    }

    const stored = await targetById(writeResult.settingsId);
    const values = writeResult.values;
    if (
      !stored ||
      stored.effectiveFrom !== target.effectiveFrom ||
      stored.calorieTargetKcal !==
        (target.mode === "fixed" ? target.calorieTargetKcal : null) ||
      (values !== null &&
        (stored.dailyDeficitKcal !== values.dailyDeficitKcal ||
          stored.activeEnergyCreditRate !== values.activeEnergyCreditRate)) ||
      stored.proteinTargetG !== target.proteinTargetG ||
      stored.status !== "active"
    ) {
      throw new Error("Nutrition target readback mismatch");
    }

    return noStore(
      Response.json(
        {
          contractVersion: NUTRITION_TARGET_CONTRACT_VERSION,
          target: nutritionTargetResponse(stored),
          requestId: idempotencyKey,
          replay: writeResult.replay,
        },
        { status: writeResult.replay ? 200 : 201 },
      ),
    );
  } catch (error) {
    return targetRouteError(error);
  }
}
