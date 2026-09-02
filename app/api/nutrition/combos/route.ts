import { and, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import {
  auditLog,
  nutritionComboItems,
  nutritionCombos,
  nutritionComboVersions,
} from "@/db/schema";
import {
  getApiActor,
  routeError,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { apiError } from "@/lib/api-error";
import { chunkByParameterLimit } from "@/lib/d1-limits";
import { findIdempotentReplay } from "@/lib/idempotency";
import {
  getNutritionCombo,
  listNutritionCombos,
  type NutritionComboMealType,
} from "@/lib/nutrition-combos";
import {
  getNutritionFood,
  normalizeFoodName,
} from "@/lib/nutrition";
import {
  NutritionMeasureError,
  resolveRegisteredFoodMeasure,
} from "@/lib/nutrition-measure";
import {
  finiteNumber,
  payloadSha256,
  rejectUnknownFields,
  requestId,
  requiredText,
} from "@/lib/record-utils";

export const dynamic = "force-dynamic";

type ComboItemInput = {
  foodId?: string;
  quantity?: number;
  unit?: string | null;
};

type ComboInput = {
  comboId?: string;
  expectedVersionNo?: number;
  action?: "revise" | "deactivate" | "reactivate";
  displayName?: string;
  defaultMealType?: NutritionComboMealType | null;
  contextTag?: "post_workout" | null;
  revisionReason?: string | null;
  items?: ComboItemInput[];
};

const mealTypes = new Set<NutritionComboMealType>([
  "breakfast",
  "lunch",
  "dinner",
  "snack",
  "late_night",
  "other",
]);

const comboItemParametersPerRow = 7;
const comboRequestReservationEntityId = "COMBO|REQUEST";
const comboItemFields = new Set(["foodId", "quantity", "unit"]);

class ComboInputError extends Error {
  readonly status: 400 | 404;
  readonly facts: Record<string, unknown>;

  constructor(
    message: string,
    status: 400 | 404 = 400,
    facts: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ComboInputError";
    this.status = status;
    this.facts = facts;
  }
}

function comboRouteError(error: unknown) {
  if (error instanceof NutritionMeasureError) {
    return apiError(
      error.errorCode,
      400,
      {
        requestedUnit: error.requestedUnit,
        basisUnit: error.basisUnit,
      },
      error.errorCode === "INCOMPATIBLE_NUTRITION_UNIT"
        ? "Incompatible nutrition unit"
        : "Nutrition measure is out of range",
    );
  }
  if (error instanceof ComboInputError) {
    return apiError(
      error.status === 404
        ? "NUTRITION_COMBO_FOOD_NOT_FOUND"
        : "INVALID_NUTRITION_COMBO_INPUT",
      error.status,
      { reason: error.message, ...error.facts },
      error.status === 404
        ? "Nutrition combo food not found"
        : "Invalid nutrition combo input",
    );
  }
  return routeError(error);
}

function parseDefaultMealType(value: ComboInput["defaultMealType"]) {
  if (value === undefined || value === null) return null;
  if (!mealTypes.has(value)) {
    throw new ComboInputError("Invalid defaultMealType");
  }
  return value;
}

function parseContextTag(value: ComboInput["contextTag"]) {
  if (value === undefined || value === null) return null;
  if (value !== "post_workout") {
    throw new ComboInputError("Invalid contextTag");
  }
  return value;
}

async function normalizeComboItems(
  values: ComboItemInput[] | undefined,
  comboVersionId: string,
) {
  if (!values || values.length === 0 || values.length > 20) {
    throw new ComboInputError(
      "items must contain between 1 and 20 records",
    );
  }
  const seenFoodIds = new Set<string>();
  const rows = [];
  for (const [index, value] of values.entries()) {
    rejectUnknownFields(value, comboItemFields, `items[${index}]`);
    const foodId = requiredText(value.foodId, `items[${index}].foodId`);
    if (seenFoodIds.has(foodId)) {
      throw new ComboInputError(`Duplicate food item: ${foodId}`);
    }
    seenFoodIds.add(foodId);
    const food = await getNutritionFood(foodId);
    if (!food || !food.isActive) {
      throw new ComboInputError(
        `Food item not found or inactive: ${foodId}`,
        404,
        { foodId, itemIndex: index },
      );
    }
    const quantity = finiteNumber(value.quantity, {
      min: 0.001,
      max: 100000,
    });
    if (quantity === null) {
      throw new Error(`items[${index}].quantity is required`);
    }
    const measure = resolveRegisteredFoodMeasure({
      quantity,
      unit: value.unit,
      baseQuantity: food.baseQuantity,
      baseUnit: food.baseUnit,
    });
    rows.push({
      comboItemId: `${comboVersionId}|ITEM|${index + 1}`,
      comboVersionId,
      itemOrdinal: index + 1,
      foodId,
      foodVersionIdAtSave: food.foodVersionId,
      defaultQuantity: measure.quantity,
      unitSnapshot: measure.unit,
    });
  }
  return rows;
}

export async function GET(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const url = new URL(request.url);
    const query = url.searchParams.get("q") || "";
    const includeInactive = url.searchParams.get("includeInactive") === "true";
    const combos = await listNutritionCombos(query, includeInactive, 80);
    return Response.json(
      { combos },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return comboRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const payload = (await request.json()) as ComboInput;
    const displayName = requiredText(payload.displayName, "displayName");
    const normalizedName = normalizeFoodName(displayName);
    const idempotencyKey = requestId(request);
    const digest = await payloadSha256(payload);
    const replayedId = await findIdempotentReplay(
      idempotencyKey,
      "nutrition_combo",
      digest,
    );
    if (replayedId) {
      return Response.json({
        comboId: replayedId,
        requestId: idempotencyKey,
        replay: true,
        combo: await getNutritionCombo(replayedId),
      });
    }

    const db = getDb();
    const duplicate = await db
      .select({ comboId: nutritionCombos.comboId })
      .from(nutritionCombos)
      .where(eq(nutritionCombos.normalizedName, normalizedName))
      .limit(1);
    if (duplicate[0]) {
      return apiError(
        "NUTRITION_COMBO_ALREADY_EXISTS",
        409,
        { comboId: duplicate[0].comboId },
        "Nutrition combo already exists",
      );
    }

    const comboId = payload.comboId?.trim() || `COMBO|${crypto.randomUUID()}`;
    const comboVersionId = `${comboId}|V1`;
    const itemRows = await normalizeComboItems(payload.items, comboVersionId);
    const defaultMealType = parseDefaultMealType(payload.defaultMealType);
    const contextTag = parseContextTag(payload.contextTag);
    const now = new Date().toISOString();
    const itemChunks = chunkByParameterLimit(
      itemRows,
      comboItemParametersPerRow,
    );

    let writeResult: { comboId: string; replay: boolean };
    try {
      writeResult = await db.transaction(async (tx) => {
        const concurrentReplayId = await findIdempotentReplay(
          idempotencyKey,
          "nutrition_combo",
          digest,
          tx,
        );
        if (concurrentReplayId) {
          return { comboId: concurrentReplayId, replay: true };
        }

        await tx.insert(auditLog).values({
          requestId: idempotencyKey,
          actor: actor.id,
          operation: "insert",
          entityType: "nutrition_combo",
          entityId: comboRequestReservationEntityId,
          payloadSha256: digest,
        });
        await tx.insert(nutritionCombos).values({
          comboId,
          displayName,
          normalizedName,
          isActive: 1,
          currentVersionNo: 1,
          source:
            actor.kind === "fitness-agent"
              ? "Agent combo creation"
              : "Site combo management",
          createdBy: actor.id,
          updatedAt: now,
        });
        await tx.insert(nutritionComboVersions).values({
          comboVersionId,
          comboId,
          versionNo: 1,
          displayNameSnapshot: displayName,
          defaultMealType,
          contextTag,
          revisionReason: payload.revisionReason?.trim() || "Initial combo",
          createdBy: actor.id,
        });
        for (const rows of itemChunks) {
          await tx.insert(nutritionComboItems).values(rows);
        }
        await tx
          .update(auditLog)
          .set({ entityId: comboId })
          .where(
            and(
              eq(auditLog.requestId, idempotencyKey),
              eq(auditLog.entityType, "nutrition_combo"),
              eq(auditLog.entityId, comboRequestReservationEntityId),
            ),
          );
        return { comboId, replay: false };
      });
    } catch (error) {
      const concurrentReplayId = await findIdempotentReplay(
        idempotencyKey,
        "nutrition_combo",
        digest,
      );
      if (!concurrentReplayId) throw error;
      writeResult = { comboId: concurrentReplayId, replay: true };
    }

    if (writeResult.replay) {
      return Response.json({
        comboId: writeResult.comboId,
        requestId: idempotencyKey,
        replay: true,
        combo: await getNutritionCombo(writeResult.comboId),
      });
    }

    return Response.json(
      {
        comboId: writeResult.comboId,
        versionNo: 1,
        requestId: idempotencyKey,
        replay: false,
        combo: await getNutritionCombo(writeResult.comboId),
      },
      { status: 201 },
    );
  } catch (error) {
    return comboRouteError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const payload = (await request.json()) as ComboInput;
    const comboId = requiredText(payload.comboId, "comboId");
    const action = payload.action ?? "revise";
    const db = getDb();
    const existingRows = await db
      .select()
      .from(nutritionCombos)
      .where(eq(nutritionCombos.comboId, comboId))
      .limit(1);
    const existing = existingRows[0] ?? null;
    if (!existing) {
      return apiError(
        "NUTRITION_COMBO_NOT_FOUND",
        404,
        { comboId },
        "Nutrition combo not found",
      );
    }
    const currentCombo = await getNutritionCombo(comboId);
    if (!currentCombo) {
      return apiError(
        "NUTRITION_COMBO_VERSION_NOT_FOUND",
        409,
        { comboId, versionNo: existing.currentVersionNo },
        "Nutrition combo version not found",
      );
    }

    const idempotencyKey = requestId(request);
    const digest = await payloadSha256(payload);
    const replayedId = await findIdempotentReplay(
      idempotencyKey,
      "nutrition_combo",
      digest,
    );
    if (replayedId) {
      return Response.json({
        comboId: replayedId,
        requestId: idempotencyKey,
        replay: true,
        combo: await getNutritionCombo(replayedId),
      });
    }

    if (action === "deactivate" || action === "reactivate") {
      await db.batch([
        db
          .update(nutritionCombos)
          .set({
            isActive: action === "deactivate" ? 0 : 1,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(nutritionCombos.comboId, comboId)),
        db.insert(auditLog).values({
          requestId: idempotencyKey,
          actor: actor.id,
          operation: action,
          entityType: "nutrition_combo",
          entityId: comboId,
          payloadSha256: digest,
        }),
      ]);
      return Response.json({
        comboId,
        requestId: idempotencyKey,
        replay: false,
        combo: await getNutritionCombo(comboId),
      });
    }
    if (action !== "revise") {
      return apiError(
        "INVALID_NUTRITION_COMBO_ACTION",
        400,
        { action, allowedActions: ["revise", "deactivate", "reactivate"] },
        "Invalid nutrition combo action",
      );
    }

    const expectedVersionNo = finiteNumber(payload.expectedVersionNo, {
      min: 1,
    });
    if (
      expectedVersionNo === null ||
      !Number.isInteger(expectedVersionNo) ||
      expectedVersionNo !== existing.currentVersionNo
    ) {
      return apiError(
        "NUTRITION_COMBO_VERSION_CONFLICT",
        409,
        { currentVersionNo: existing.currentVersionNo },
        "Nutrition combo version conflict",
      );
    }

    const displayName = payload.displayName?.trim() || existing.displayName;
    const normalizedName = normalizeFoodName(displayName);
    const duplicate = await db
      .select({ comboId: nutritionCombos.comboId })
      .from(nutritionCombos)
      .where(
        and(
          eq(nutritionCombos.normalizedName, normalizedName),
          ne(nutritionCombos.comboId, comboId),
        ),
      )
      .limit(1);
    if (duplicate[0]) {
      return apiError(
        "NUTRITION_COMBO_ALREADY_EXISTS",
        409,
        { comboId: duplicate[0].comboId },
        "Nutrition combo already exists",
      );
    }

    const versionNo = existing.currentVersionNo + 1;
    const comboVersionId = `${comboId}|V${versionNo}`;
    const itemRows = await normalizeComboItems(payload.items, comboVersionId);
    const defaultMealType =
      payload.defaultMealType === undefined
        ? currentCombo.defaultMealType
        : parseDefaultMealType(payload.defaultMealType);
    const contextTag =
      payload.contextTag === undefined
        ? currentCombo.contextTag
        : parseContextTag(payload.contextTag);
    const itemStatements = chunkByParameterLimit(
      itemRows,
      comboItemParametersPerRow,
    ).map((rows) => db.insert(nutritionComboItems).values(rows));

    await db.batch([
      db.insert(nutritionComboVersions).values({
        comboVersionId,
        comboId,
        versionNo,
        displayNameSnapshot: displayName,
        defaultMealType,
        contextTag,
        revisionReason:
          payload.revisionReason?.trim() || "Site combo revision",
        createdBy: actor.id,
      }),
      ...itemStatements,
      db
        .update(nutritionCombos)
        .set({
          displayName,
          normalizedName,
          currentVersionNo: versionNo,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(nutritionCombos.comboId, comboId)),
      db.insert(auditLog).values({
        requestId: idempotencyKey,
        actor: actor.id,
        operation: "revise",
        entityType: "nutrition_combo",
        entityId: comboId,
        payloadSha256: digest,
      }),
    ]);

    return Response.json({
      comboId,
      versionNo,
      requestId: idempotencyKey,
      replay: false,
      combo: await getNutritionCombo(comboId),
    });
  } catch (error) {
    return comboRouteError(error);
  }
}
