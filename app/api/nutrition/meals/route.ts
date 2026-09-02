import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import {
  auditLog,
  nutritionMealComboSources,
  nutritionMealItems,
  nutritionMealRevisions,
  nutritionMeals,
} from "@/db/schema";
import {
  getApiActor,
  routeError,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { apiError } from "@/lib/api-error";
import { findIdempotentReplay } from "@/lib/idempotency";
import { chunkByParameterLimit } from "@/lib/d1-limits";
import {
  MealClassificationValidationError,
  validateMealClassification,
} from "@/lib/nutrition-classification";
import {
  NutritionMeasureError,
  requireQuantityForExplicitNutritionUnit,
  resolveRegisteredFoodMeasure,
  resolveRelativeNutritionMeasure,
} from "@/lib/nutrition-measure";
import {
  getNutritionDay,
  getNutritionFood,
  inferMealType,
  nutrientKeys,
  nullNutrients,
  pickNutrients,
  scaleNutrients,
  sumNutrients,
  type NutrientKey,
  type Nutrients,
  type NutritionMealView,
} from "@/lib/nutrition";
import {
  getNutritionCombo,
  type NutritionComboView,
} from "@/lib/nutrition-combos";
import {
  finiteNumber,
  isDateOnly,
  isIsoTimestamp,
  payloadSha256,
  rejectUnknownFields,
  requestId,
  requiredText,
} from "@/lib/record-utils";
import { getProfileTimezone } from "@/lib/profile-timezone";
import {
  dateInTimeZone,
  localDateFromTimestamp as dateFromTimestamp,
} from "@/lib/timezone.mjs";

export const dynamic = "force-dynamic";

class MealRevisionWriteConflict extends Error {}

function mealRouteError(error: unknown) {
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
        : error.errorCode === "NUTRITION_QUANTITY_REQUIRED_FOR_UNIT"
          ? "Quantity is required when unit is supplied"
        : "Nutrition measure is out of range",
    );
  }
  if (error instanceof MealClassificationValidationError) {
    return apiError(
      "INVALID_MEAL_CLASSIFICATION",
      400,
      { reason: error.message },
      "Invalid meal classification",
    );
  }
  if (error instanceof MealRevisionWriteConflict) {
    return apiError(
      "MEAL_REVISION_CONFLICT",
      409,
      {},
      "Meal revision conflict",
    );
  }
  return routeError(error);
}

type MealType = NutritionMealView["mealType"];
type Confidence = "high" | "medium" | "low";

type MealItemInput = {
  foodId?: string;
  name?: string;
  quantity?: number;
  unit?: string | null;
  confidence?: Confidence;
  assumption?: string | null;
  nutrients?: Partial<Record<NutrientKey, number | null>>;
};

type MealInput = {
  mealId?: string;
  expectedRevisionNo?: number;
  localDate?: string;
  eatenAt?: string | null;
  timePrecision?: "exact" | "inferred" | "date_only";
  mealType?: MealType;
  contextTag?: string | null;
  originalMealType?: string | null;
  source?: string;
  confidence?: Confidence;
  revisionReason?: string | null;
  originalText?: string | null;
  notes?: string | null;
  items?: MealItemInput[];
  combo?: {
    comboId?: string;
    expectedVersionNo?: number;
    quantityOverrides?: Array<{
      comboItemId?: string;
      quantity?: number;
    }>;
    excludedItemIds?: string[];
  };
};

type MealQuantityPatchInput = {
  mealId?: string;
  mealItemId?: string;
  foodId?: string;
  expectedRevisionNo?: number;
  quantity?: number;
  unit?: string | null;
  action?: "quantity" | "classification" | "append_food";
  mealType?: MealType;
  contextTag?: string | null;
  originalMealType?: string | null;
  revisionReason?: string | null;
};

type MealItemDeleteInput = {
  mealId?: string;
  mealItemId?: string;
  deleteMeal?: boolean;
  expectedRevisionNo?: number;
  revisionReason?: string | null;
};

// nutrition_meal_items has at most 22 bound columns per row. D1 permits at
// most 100 bound parameters per statement, so four rows is the safe maximum
// for one multi-row INSERT.
const mealItemParametersPerRow = 22;

const mealTypes = new Set<MealType>([
  "breakfast",
  "lunch",
  "dinner",
  "snack",
  "late_night",
  "other",
]);
const confidenceValues = new Set<Confidence>(["high", "medium", "low"]);
const mealItemFields = new Set([
  "foodId",
  "name",
  "quantity",
  "unit",
  "confidence",
  "assumption",
  "nutrients",
]);
const mealNutrientFields = new Set<string>(nutrientKeys);
const mealQuantityPatchFields = new Set([
  "action",
  "mealId",
  "mealItemId",
  "expectedRevisionNo",
  "quantity",
  "unit",
  "revisionReason",
]);
const mealClassificationPatchFields = new Set([
  "action",
  "mealId",
  "expectedRevisionNo",
  "mealType",
  "contextTag",
  "originalMealType",
  "revisionReason",
]);
const mealAppendFoodPatchFields = new Set([
  "action",
  "mealId",
  "foodId",
  "expectedRevisionNo",
  "quantity",
  "unit",
  "revisionReason",
]);
const timePrecisionValues = new Set([
  "exact",
  "inferred",
  "date_only",
] as const);

function revisionReceiptAudit(input: {
  requestId: string;
  actor: string;
  digest: string;
  mealRevisionId: string;
}) {
  return {
    requestId: input.requestId,
    actor: input.actor,
    operation: "revision_receipt",
    entityType: "nutrition_meal_revision",
    entityId: input.mealRevisionId,
    payloadSha256: input.digest,
  } as const;
}

function replayMealOverrides(
  payload: MealInput | MealQuantityPatchInput,
): Partial<NutritionMealView> {
  const fields = [
    "localDate",
    "eatenAt",
    "timePrecision",
    "mealType",
    "contextTag",
    "originalMealType",
    "source",
    "confidence",
  ] as const;
  const overrides: Record<string, unknown> = {};
  const values = payload as Record<string, unknown>;
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      overrides[field] = values[field];
    }
  }
  return overrides as Partial<NutritionMealView>;
}

async function nutritionForMealRevision(
  db: ReturnType<typeof getDb>,
  mealId: string,
  revisionNo: number,
  localDate: string,
  overrides: Partial<NutritionMealView> = {},
) {
  const mealRows = await db
    .select()
    .from(nutritionMeals)
    .where(eq(nutritionMeals.mealId, mealId))
    .limit(1);
  const meal = mealRows[0];
  const revisionRows = await db
    .select()
    .from(nutritionMealRevisions)
    .where(
      and(
        eq(nutritionMealRevisions.mealId, mealId),
        eq(nutritionMealRevisions.revisionNo, revisionNo),
      ),
    )
    .limit(1);
  const revision = revisionRows[0];
  if (!meal || !revision) {
    throw new Error("Nutrition meal replay revision is unavailable");
  }
  const itemRows = await db
    .select()
    .from(nutritionMealItems)
    .where(eq(nutritionMealItems.mealRevisionId, revision.mealRevisionId))
    .orderBy(asc(nutritionMealItems.itemOrdinal));
  const replayMeal: NutritionMealView = {
    mealId: meal.mealId,
    localDate: meal.localDate,
    eatenAt: meal.eatenAt,
    timePrecision: meal.timePrecision as NutritionMealView["timePrecision"],
    mealType: meal.mealType as NutritionMealView["mealType"],
    contextTag: meal.contextTag,
    originalMealType: meal.originalMealType,
    source: meal.source,
    confidence: meal.confidence as NutritionMealView["confidence"],
    revisionNo,
    originalText: revision.originalText,
    notes: revision.notes,
    nutrients: pickNutrients(revision),
    items: itemRows.map((item) => ({
      mealItemId: item.mealItemId,
      name: item.itemNameSnapshot,
      quantity: item.quantity,
      unit: item.unit,
      foodId: item.foodId,
      nutrients: pickNutrients(item),
      assumption: item.assumption,
      confidence: item.confidence as "high" | "medium" | "low",
      dataQualityFlags: item.dataQualityFlags,
    })),
    ...overrides,
  };
  const nutrition = await getNutritionDay(localDate);
  const mealIndex = nutrition.meals.findIndex(
    (candidate) => candidate.mealId === mealId,
  );
  return {
    ...nutrition,
    meals:
      mealIndex < 0
        ? [...nutrition.meals, replayMeal]
        : nutrition.meals.map((candidate, index) =>
            index === mealIndex ? replayMeal : candidate,
          ),
  };
}

async function replayPatchRevisionNo(
  db: ReturnType<typeof getDb>,
  idempotencyKey: string,
  digest: string,
  mealId: string,
  action: MealQuantityPatchInput["action"],
  expectedRevisionNo: number,
  mealItemId: string | null,
  quantity: number | null,
) {
  const receiptRevisionId = await findIdempotentReplay(
    idempotencyKey,
    "nutrition_meal_revision",
    digest,
    db,
  );
  if (receiptRevisionId) {
    const receiptRows = await db
      .select({ revisionNo: nutritionMealRevisions.revisionNo })
      .from(nutritionMealRevisions)
      .where(
        and(
          eq(nutritionMealRevisions.mealId, mealId),
          eq(nutritionMealRevisions.mealRevisionId, receiptRevisionId),
        ),
      )
      .limit(1);
    if (!receiptRows[0]) {
      throw new Error("Nutrition meal replay revision is unavailable");
    }
    return receiptRows[0].revisionNo;
  }

  const candidateRevisionNos =
    action === "classification"
      ? [expectedRevisionNo, expectedRevisionNo + 1]
      : [expectedRevisionNo + 1, expectedRevisionNo];
  const revisions = await db
    .select({
      revisionNo: nutritionMealRevisions.revisionNo,
      mealRevisionId: nutritionMealRevisions.mealRevisionId,
    })
    .from(nutritionMealRevisions)
    .where(
      and(
        eq(nutritionMealRevisions.mealId, mealId),
        eq(nutritionMealRevisions.revisionNo, candidateRevisionNos[0]),
      ),
    )
    .limit(1);
  if (action === "classification" || action === "append_food") {
    return revisions[0]?.revisionNo ?? expectedRevisionNo;
  }
  if (!mealItemId || quantity === null) return expectedRevisionNo + 1;
  const ordinal = mealItemId.split("|ITEM|").at(-1);
  if (!ordinal) return expectedRevisionNo + 1;
  const candidateRevision = revisions[0];
  if (!candidateRevision) return expectedRevisionNo;
  const itemRows = await db
    .select({ quantity: nutritionMealItems.quantity })
    .from(nutritionMealItems)
    .where(
      and(
        eq(
          nutritionMealItems.mealRevisionId,
          candidateRevision.mealRevisionId,
        ),
        eq(nutritionMealItems.itemOrdinal, Number(ordinal)),
      ),
    )
    .limit(1);
  return itemRows[0]?.quantity !== null &&
    itemRows[0]?.quantity !== undefined &&
    Math.abs(itemRows[0].quantity - quantity) < 0.000001
    ? candidateRevision.revisionNo
    : expectedRevisionNo;
}

function parseEstimatedNutrients(
  value: MealItemInput["nutrients"],
): Nutrients {
  if (!value) throw new Error("nutrients is required");
  const result = nullNutrients();
  for (const key of nutrientKeys) {
    const input = value[key];
    result[key] = finiteNumber(input, {
      min: 0,
      max: key === "sodiumMg" ? 100000 : 50000,
      optional: true,
    });
  }
  if (result.energyKcal === null) {
    throw new Error("energyKcal is required");
  }
  return result;
}

export async function POST(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const timezone = await getProfileTimezone();
    const payload = (await request.json()) as MealInput;
    if (payload.combo && payload.items) {
      return apiError(
        "MEAL_ITEMS_COMBO_CONFLICT",
        400,
        { fields: ["items", "combo"] },
        "Meal items and combo cannot both be provided",
      );
    }
    if (payload.combo && payload.mealId) {
      return apiError(
        "MEAL_COMBO_REQUIRES_NEW_MEAL",
        400,
        { fields: ["combo", "mealId"] },
        "Meal combo requires a new meal",
      );
    }
    const idempotencyKey = requestId(request);
    const digest = await payloadSha256(payload);
    const generatedMealId =
      payload.mealId?.trim() ||
      `MEAL|REQUEST|${await payloadSha256(idempotencyKey)}`;
    const mealId = generatedMealId;
    const db = getDb();
    const existingRows = await db
      .select()
      .from(nutritionMeals)
      .where(eq(nutritionMeals.mealId, mealId))
      .limit(1);
    const existing = existingRows[0] ?? null;
    const existingRevisionRows = existing
      ? await db
          .select()
          .from(nutritionMealRevisions)
          .where(
            and(
              eq(nutritionMealRevisions.mealId, mealId),
              eq(
                nutritionMealRevisions.revisionNo,
                existing.currentRevisionNo,
              ),
            ),
          )
          .limit(1)
      : [];
    const existingRevision = existingRevisionRows[0] ?? null;
    const eatenAt =
      payload.eatenAt === undefined
        ? existing?.eatenAt ?? null
        : payload.eatenAt;
    if (eatenAt !== null && !isIsoTimestamp(eatenAt)) {
      return apiError(
        "INVALID_MEAL_TIMESTAMP",
        400,
        { field: "eatenAt" },
        "Invalid meal timestamp",
      );
    }

    const localDate =
      payload.localDate !== undefined
        ? payload.localDate
        : payload.eatenAt
          ? dateFromTimestamp(payload.eatenAt, timezone)
          : existing?.localDate ??
            dateInTimeZone(new Date(), timezone);
    if (!isDateOnly(localDate)) {
      return apiError(
        "INVALID_MEAL_LOCAL_DATE",
        400,
        { field: "localDate" },
        "Invalid meal local date",
      );
    }
    if (eatenAt && dateFromTimestamp(eatenAt, timezone) !== localDate) {
      return apiError(
        "MEAL_LOCAL_DATE_MISMATCH",
        400,
        { localDate, timezone },
        "Meal local date does not match timestamp",
      );
    }

    let mealTypeInferred = !existing && !payload.mealType;
    let mealType =
      payload.mealType ??
      (existing?.mealType as MealType | undefined) ??
      inferMealType(eatenAt ? new Date(eatenAt) : new Date(), timezone);
    if (!mealTypes.has(mealType)) {
      return apiError(
        "INVALID_MEAL_TYPE",
        400,
        { mealType, allowedMealTypes: [...mealTypes] },
        "Invalid meal type",
      );
    }

    const confidence =
      payload.confidence ??
      (existing?.confidence as Confidence | undefined) ??
      "medium";
    if (!confidenceValues.has(confidence)) {
      return apiError(
        "INVALID_MEAL_CONFIDENCE",
        400,
        { confidence, allowedConfidenceValues: [...confidenceValues] },
        "Invalid meal confidence",
      );
    }
    const timePrecision =
      payload.timePrecision ??
      (payload.eatenAt !== undefined
        ? payload.eatenAt
          ? "exact"
          : "date_only"
        : (existing?.timePrecision as
            | "exact"
            | "inferred"
            | "date_only"
            | undefined) ??
          (eatenAt ? "exact" : "date_only"));
    if (!timePrecisionValues.has(timePrecision)) {
      return apiError(
        "INVALID_MEAL_TIME_PRECISION",
        400,
        { timePrecision, allowedTimePrecisionValues: [...timePrecisionValues] },
        "Invalid meal time precision",
      );
    }
    if (
      (eatenAt === null && timePrecision !== "date_only") ||
      (eatenAt !== null && timePrecision === "date_only")
    ) {
      return apiError(
        "MEAL_TIME_PRECISION_MISMATCH",
        400,
        { timePrecision, hasTimestamp: eatenAt !== null },
        "Meal time precision does not match timestamp",
      );
    }

    const replayMealCreate = async (replayedId: string) => {
      const replayedRows = await db
        .select()
        .from(nutritionMeals)
        .where(eq(nutritionMeals.mealId, replayedId))
        .limit(1);
      const replayedMeal = replayedRows[0] ?? null;
      const replayRevisionNo =
        typeof payload.expectedRevisionNo === "number" &&
        Number.isInteger(payload.expectedRevisionNo)
          ? payload.expectedRevisionNo + 1
          : 1;
      let replayNutrition = await getNutritionDay(
        replayedMeal?.localDate ?? localDate,
      );
      if (replayedMeal) {
        try {
          replayNutrition = await nutritionForMealRevision(
            db,
            replayedId,
            replayRevisionNo,
            payload.localDate ?? replayedMeal.localDate,
            replayMealOverrides(payload),
          );
        } catch {
          // Preserve the existing replay response if historical rows are unavailable.
        }
      }
      return Response.json({
        mealId: replayedId,
        revisionNo: replayedMeal ? replayRevisionNo : null,
        requestId: idempotencyKey,
        replay: true,
        mealType:
          replayMealOverrides(payload).mealType ??
          replayedMeal?.mealType ??
          mealType,
        mealTypeInferred: false,
        nutrition: replayNutrition,
      });
    };
    const replayedId = await findIdempotentReplay(
      idempotencyKey,
      "nutrition_meal",
      digest,
    );
    if (replayedId) {
      return replayMealCreate(replayedId);
    }

    if (existing?.voidedAt) {
      return apiError(
        "MEAL_ALREADY_VOIDED",
        409,
        { mealId, voidedAt: existing.voidedAt },
        "Meal is already voided",
      );
    }

    if (existing) {
      if (payload.expectedRevisionNo === undefined) {
        return apiError(
          "MEAL_REVISION_REQUIRED",
          409,
          { currentRevisionNo: existing.currentRevisionNo },
          "Meal revision number is required",
        );
      }
      const expectedRevisionNo = finiteNumber(payload.expectedRevisionNo, {
        min: 1,
      });
      if (expectedRevisionNo !== existing.currentRevisionNo) {
        return apiError(
          "MEAL_REVISION_CONFLICT",
          409,
          { currentRevisionNo: existing.currentRevisionNo },
          "Meal revision conflict",
        );
      }
    } else if (payload.expectedRevisionNo !== undefined) {
      return apiError(
        "MEAL_REVISION_WITHOUT_EXISTING_MEAL",
        400,
        { field: "expectedRevisionNo" },
        "Meal revision number requires an existing meal",
      );
    }

    let appliedCombo: NutritionComboView | null = null;
    let inputs = payload.items ?? [];
    if (payload.combo) {
      const comboId = requiredText(payload.combo.comboId, "combo.comboId");
      const expectedVersionNo = finiteNumber(
        payload.combo.expectedVersionNo,
        { min: 1 },
      );
      if (expectedVersionNo === null || !Number.isInteger(expectedVersionNo)) {
        return apiError(
          "INVALID_MEAL_COMBO_VERSION",
          400,
          { field: "combo.expectedVersionNo" },
          "Invalid meal combo version",
        );
      }
      const combo = await getNutritionCombo(comboId);
      if (!combo) {
        return apiError(
          "NUTRITION_COMBO_NOT_FOUND",
          404,
          { comboId },
          "Nutrition combo not found",
        );
      }
      if (combo.versionNo !== expectedVersionNo) {
        return apiError(
          "NUTRITION_COMBO_VERSION_CONFLICT",
          409,
          { currentVersionNo: combo.versionNo },
          "Nutrition combo version conflict",
        );
      }
      if (!combo.isUsable) {
        return apiError(
          "NUTRITION_COMBO_UNUSABLE",
          409,
          {
            issues: combo.issues.map(({ code, comboItemId, foodId }) => ({
              code,
              comboItemId,
              foodId,
            })),
          },
          "Nutrition combo is unusable",
        );
      }

      const itemIds = new Set(combo.items.map((item) => item.comboItemId));
      const excluded = new Set(payload.combo.excludedItemIds ?? []);
      const unknownExcludedItemIds = [...excluded].filter(
        (itemId) => !itemIds.has(itemId),
      );
      if (unknownExcludedItemIds.length > 0) {
        return apiError(
          "UNKNOWN_EXCLUDED_COMBO_ITEM",
          400,
          { comboItemIds: unknownExcludedItemIds },
          "Unknown excluded combo item",
        );
      }
      const overrides = new Map<string, number>();
      for (const [index, override] of (
        payload.combo.quantityOverrides ?? []
      ).entries()) {
        const comboItemId = requiredText(
          override.comboItemId,
          `combo.quantityOverrides[${index}].comboItemId`,
        );
        if (!itemIds.has(comboItemId)) {
          return apiError(
            "UNKNOWN_COMBO_ITEM",
            400,
            { comboItemId },
            "Unknown combo item",
          );
        }
        if (overrides.has(comboItemId)) {
          return apiError(
            "DUPLICATE_COMBO_OVERRIDE",
            400,
            { comboItemId },
            "Duplicate combo override",
          );
        }
        const quantity = finiteNumber(override.quantity, {
          min: 0.001,
          max: 100000,
        });
        if (quantity === null) {
          return apiError(
            "INVALID_COMBO_QUANTITY",
            400,
            { comboItemId },
            "Invalid combo quantity",
          );
        }
        overrides.set(comboItemId, quantity);
      }

      inputs = combo.items
        .filter((item) => !excluded.has(item.comboItemId))
        .map((item) => ({
          foodId: item.foodId,
          quantity: overrides.get(item.comboItemId) ?? item.defaultQuantity,
          unit: item.unitAtSave,
          confidence: "high" as const,
        }));
      if (inputs.length === 0) {
        return apiError(
          "EMPTY_MEAL_COMBO",
          400,
          { minimumItems: 1 },
          "Meal combo must contain an item",
        );
      }
      if (payload.mealType === undefined && combo.defaultMealType) {
        mealType = combo.defaultMealType;
        mealTypeInferred = false;
      }
      appliedCombo = combo;
    }
    if (!mealTypes.has(mealType)) {
      return apiError(
        "INVALID_MEAL_TYPE",
        400,
        { mealType, allowedMealTypes: [...mealTypes] },
        "Invalid meal type",
      );
    }
    const contextTag =
      payload.contextTag === undefined
        ? existing?.contextTag ?? appliedCombo?.contextTag ?? null
        : payload.contextTag?.trim() || null;
    const originalMealType =
      payload.originalMealType === undefined
        ? existing?.originalMealType ?? null
        : payload.originalMealType?.trim() || null;
    validateMealClassification({
      mealType,
      contextTag,
      originalMealType,
    });
    if (inputs.length === 0 || inputs.length > 60) {
      return apiError(
        "INVALID_MEAL_ITEM_COUNT",
        400,
        { itemCount: inputs.length, minimumItems: 1, maximumItems: 60 },
        "Invalid meal item count",
      );
    }

    const normalizedItems = [];
    for (const [index, item] of inputs.entries()) {
      rejectUnknownFields(item, mealItemFields, `items[${index}]`);
      if (item.nutrients !== undefined) {
        rejectUnknownFields(
          item.nutrients,
          mealNutrientFields,
          `items[${index}].nutrients`,
        );
      }
      const itemConfidence = item.confidence ?? confidence;
      if (!confidenceValues.has(itemConfidence)) {
        return apiError(
          "INVALID_MEAL_ITEM_CONFIDENCE",
          400,
          { itemIndex: index, confidence: itemConfidence },
          "Invalid meal item confidence",
        );
      }

      if (item.foodId) {
        const food = await getNutritionFood(item.foodId);
        if (!food || !food.isActive) {
          return apiError(
            "NUTRITION_FOOD_NOT_FOUND_OR_INACTIVE",
            404,
            { foodId: item.foodId },
            "Nutrition food not found or inactive",
          );
        }
        requireQuantityForExplicitNutritionUnit({
          quantity: item.quantity,
          unit: item.unit,
          basisUnit: food.baseUnit,
        });
        const quantity = finiteNumber(
          item.quantity ?? food.baseQuantity,
          {
          min: 0.001,
          max: 100000,
          },
        )!;
        const measure = resolveRegisteredFoodMeasure({
          quantity,
          unit: item.unit,
          baseQuantity: food.baseQuantity,
          baseUnit: food.baseUnit,
        });
        normalizedItems.push({
          foodId: food.foodId,
          foodVersionId: food.foodVersionId,
          name: food.displayName,
          quantity: measure.quantity,
          unit: measure.unit,
          nutrients: scaleNutrients(
            food.nutrients,
            measure.nutrientScale,
          ),
          assumption: item.assumption?.trim() || null,
          confidence: itemConfidence,
        });
        continue;
      }

      normalizedItems.push({
        foodId: null,
        foodVersionId: null,
        name: requiredText(item.name, `items[${index}].name`),
        quantity: finiteNumber(item.quantity, {
          min: 0,
          max: 100000,
          optional: true,
        }),
        unit: item.unit?.trim() || null,
        nutrients: parseEstimatedNutrients(item.nutrients),
        assumption: item.assumption?.trim() || null,
        confidence: itemConfidence,
      });
    }

    const totals = sumNutrients(
      normalizedItems.map((item) => item.nutrients),
    );
    const revisionNo = existing ? existing.currentRevisionNo + 1 : 1;
    const mealRevisionId = `${mealId}|REV|${revisionNo}`;
    const now = new Date().toISOString();
    const itemRows = normalizedItems.map((item, index) => ({
      mealItemId: `${mealRevisionId}|ITEM|${index + 1}`,
      mealRevisionId,
      itemOrdinal: index + 1,
      foodId: item.foodId,
      foodVersionId: item.foodVersionId,
      itemNameSnapshot: item.name,
      quantity: item.quantity,
      unit: item.unit,
      ...item.nutrients,
      assumption: item.assumption,
      confidence: item.confidence,
      dataQualityFlags: null,
    }));

    const mealValues = {
      localDate,
      eatenAt,
      timePrecision,
      mealType,
      contextTag,
      originalMealType,
      source:
        payload.source === undefined
          ? existing?.source ??
            (appliedCombo
              ? "site_combo"
              : actor.kind === "fitness-agent"
                ? "chat_estimate"
                : "site_quick_add")
          : payload.source.trim() ||
            (actor.kind === "fitness-agent"
              ? "chat_estimate"
              : "site_quick_add"),
      confidence,
      currentRevisionNo: revisionNo,
      updatedAt: now,
    } as const;

    let concurrentReplayId: string | null = null;
    await db.transaction(async (tx) => {
      concurrentReplayId = await findIdempotentReplay(
        idempotencyKey,
        "nutrition_meal",
        digest,
        tx,
      );
      if (concurrentReplayId) return;

      const itemInsertStatements = chunkByParameterLimit(
        itemRows,
        mealItemParametersPerRow,
      ).map((rows) => tx.insert(nutritionMealItems).values(rows));
      const statements = [
        existing
          ? tx
              .update(nutritionMeals)
              .set(mealValues)
              .where(eq(nutritionMeals.mealId, mealId))
          : tx.insert(nutritionMeals).values({
              mealId,
              ...mealValues,
              createdBy: actor.id,
            }),
        tx.insert(nutritionMealRevisions).values({
          mealRevisionId,
          mealId,
          revisionNo,
          revisionReason:
            payload.revisionReason?.trim() ||
            (existing
              ? "User correction"
              : appliedCombo
                ? "Initial record from combo"
                : "Initial record"),
          originalText:
            payload.originalText === undefined
              ? existingRevision?.originalText ?? null
              : payload.originalText?.trim() || null,
          notes:
            payload.notes === undefined
              ? existingRevision?.notes ?? null
              : payload.notes?.trim() || null,
          ...pickNutrients(totals),
          createdBy: actor.id,
        }),
        ...(appliedCombo
          ? [
              tx.insert(nutritionMealComboSources).values({
                mealRevisionId,
                comboVersionId: appliedCombo.comboVersionId,
              }),
            ]
          : []),
        ...itemInsertStatements,
        tx.insert(auditLog).values({
          requestId: idempotencyKey,
          actor: actor.id,
          operation: existing
            ? "revise"
            : appliedCombo
              ? "insert_from_combo"
              : "insert",
          entityType: "nutrition_meal",
          entityId: mealId,
          payloadSha256: digest,
        }),
      ] as const;

      for (const statement of statements) await statement;
    });
    if (concurrentReplayId) return replayMealCreate(concurrentReplayId);
    return Response.json(
      {
        mealId,
        revisionNo,
        requestId: idempotencyKey,
        replay: false,
        mealType,
        mealTypeInferred,
        totals,
        comboId: appliedCombo?.comboId ?? null,
        comboVersionNo: appliedCombo?.versionNo ?? null,
        nutrition: await getNutritionDay(localDate),
      },
      { status: existing ? 200 : 201 },
    );
  } catch (error) {
    return mealRouteError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const payload = (await request.json()) as MealQuantityPatchInput;
    const action = payload.action ?? "quantity";
    if (
      action !== "quantity" &&
      action !== "classification" &&
      action !== "append_food"
    ) {
      return apiError(
        "INVALID_MEAL_PATCH_ACTION",
        400,
        { action, allowedActions: ["quantity", "classification", "append_food"] },
        "Invalid meal patch action",
      );
    }
    rejectUnknownFields(
      payload,
      action === "classification"
        ? mealClassificationPatchFields
        : action === "append_food"
          ? mealAppendFoodPatchFields
          : mealQuantityPatchFields,
      `meal ${action} patch`,
    );
    const mealId = requiredText(payload.mealId, "mealId");
    const mealItemId =
      action === "quantity"
        ? requiredText(payload.mealItemId, "mealItemId")
        : null;
    const expectedRevisionNo = finiteNumber(payload.expectedRevisionNo, {
      min: 1,
    });
    if (
      expectedRevisionNo === null ||
      !Number.isInteger(expectedRevisionNo)
    ) {
      return apiError(
        "INVALID_MEAL_REVISION",
        400,
        { field: "expectedRevisionNo" },
        "Invalid meal revision number",
      );
    }
    const quantity =
      action === "quantity" || action === "append_food"
        ? finiteNumber(payload.quantity, {
            min: 0.001,
            max: 100000,
          })!
        : null;
    const db = getDb();
    const mealRows = await db
      .select()
      .from(nutritionMeals)
      .where(eq(nutritionMeals.mealId, mealId))
      .limit(1);
    const meal = mealRows[0] ?? null;
    if (!meal) {
      return apiError(
        "MEAL_NOT_FOUND",
        404,
        { mealId },
        "Meal not found",
      );
    }

    const idempotencyKey = requestId(request);
    const digest = await payloadSha256(payload);
    const replayedId = await findIdempotentReplay(
      idempotencyKey,
      "nutrition_meal",
      digest,
    );
    const replayMealPatch = async (replayedId: string) => {
      if (replayedId !== mealId) {
        throw new Error("Nutrition meal replay is unavailable");
      }
      const replayedRows = await db
        .select()
        .from(nutritionMeals)
        .where(eq(nutritionMeals.mealId, replayedId))
        .limit(1);
      const replayedMeal = replayedRows[0];
      if (!replayedMeal) {
        throw new Error("Nutrition meal replay is unavailable");
      }
      const replayRevisionNo = await replayPatchRevisionNo(
        db,
        idempotencyKey,
        digest,
        replayedMeal.mealId,
        action,
        expectedRevisionNo,
        mealItemId,
        quantity,
      );
      let replayNutrition = await getNutritionDay(replayedMeal.localDate);
      try {
        replayNutrition = await nutritionForMealRevision(
          db,
          replayedMeal.mealId,
          replayRevisionNo,
          replayedMeal.localDate,
          replayMealOverrides(payload),
        );
      } catch {
        // Preserve the existing replay response if historical rows are unavailable.
      }
      return Response.json({
        mealId: replayedMeal.mealId,
        revisionNo: replayRevisionNo,
        requestId: idempotencyKey,
        replay: true,
        unchanged: replayRevisionNo === expectedRevisionNo,
        nutrition: replayNutrition,
      });
    };
    if (replayedId) {
      return replayMealPatch(replayedId);
    }

    if (meal.currentRevisionNo !== expectedRevisionNo) {
      return apiError(
        "MEAL_REVISION_CONFLICT",
        409,
        { currentRevisionNo: meal.currentRevisionNo },
        "Meal revision conflict",
      );
    }
    if (meal.voidedAt) {
      return apiError(
        "MEAL_ALREADY_VOIDED",
        409,
        { mealId, voidedAt: meal.voidedAt },
        "Meal is already voided",
      );
    }

    const revisionRows = await db
      .select()
      .from(nutritionMealRevisions)
      .where(
        and(
          eq(nutritionMealRevisions.mealId, mealId),
          eq(
            nutritionMealRevisions.revisionNo,
            meal.currentRevisionNo,
          ),
        ),
      )
      .limit(1);
    const currentRevision = revisionRows[0] ?? null;
    if (!currentRevision) {
      return apiError(
        "MEAL_REVISION_NOT_FOUND",
        409,
        { mealId, revisionNo: meal.currentRevisionNo },
        "Meal revision not found",
      );
    }

    const currentItems = await db
      .select()
      .from(nutritionMealItems)
      .where(
        eq(
          nutritionMealItems.mealRevisionId,
          currentRevision.mealRevisionId,
        ),
      )
      .orderBy(asc(nutritionMealItems.itemOrdinal));

    if (action === "classification") {
      const nextMealType = payload.mealType;
      if (!nextMealType || !mealTypes.has(nextMealType)) {
        return apiError(
          "INVALID_MEAL_TYPE",
          400,
          { mealType: nextMealType, allowedMealTypes: [...mealTypes] },
          "Invalid meal type",
        );
      }
      const nextContextTag =
        payload.contextTag === undefined
          ? null
          : payload.contextTag?.trim() || null;
      const nextOriginalMealType =
        payload.originalMealType === undefined
          ? null
          : payload.originalMealType?.trim() || null;
      validateMealClassification({
        mealType: nextMealType,
        contextTag: nextContextTag,
        originalMealType: nextOriginalMealType,
      });

      if (
        meal.mealType === nextMealType &&
        (meal.contextTag ?? null) === nextContextTag &&
        (meal.originalMealType ?? null) === nextOriginalMealType
      ) {
        let noOpReplayId: string | null = null;
        let noOpMeal: typeof nutritionMeals.$inferSelect | null = null;
        let noOpConflict: number | "voided" | null = null;
        await db.transaction(async (tx) => {
          noOpReplayId = await findIdempotentReplay(
            idempotencyKey,
            "nutrition_meal",
            digest,
            tx,
          );
          if (noOpReplayId) return;
          const latestRows = await tx
            .select()
            .from(nutritionMeals)
            .where(eq(nutritionMeals.mealId, mealId))
            .limit(1);
          const latestMeal = latestRows[0];
          if (!latestMeal) {
            noOpConflict = -1;
            return;
          }
          if (latestMeal.voidedAt) {
            noOpConflict = "voided";
            return;
          }
          if (
            latestMeal.currentRevisionNo !== expectedRevisionNo ||
            latestMeal.mealType !== nextMealType ||
            (latestMeal.contextTag ?? null) !== nextContextTag ||
            (latestMeal.originalMealType ?? null) !== nextOriginalMealType
          ) {
            noOpConflict = latestMeal.currentRevisionNo;
            return;
          }
          await tx.insert(auditLog).values({
            requestId: idempotencyKey,
            actor: actor.id,
            operation: "revise_classification",
            entityType: "nutrition_meal",
            entityId: mealId,
            payloadSha256: digest,
          });
          await tx.insert(auditLog).values(
            revisionReceiptAudit({
              requestId: idempotencyKey,
              actor: actor.id,
              digest,
              mealRevisionId: currentRevision.mealRevisionId,
            }),
          );
          noOpMeal = latestMeal;
        });
        if (noOpReplayId) return replayMealPatch(noOpReplayId);
        if (noOpConflict === "voided") {
          return apiError(
            "MEAL_ALREADY_VOIDED",
            409,
            { mealId },
            "Meal is already voided",
          );
        }
        if (noOpConflict !== null || !noOpMeal) {
          return apiError(
            "MEAL_REVISION_CONFLICT",
            409,
            {
              currentRevisionNo:
                typeof noOpConflict === "number"
                  ? noOpConflict
                  : meal.currentRevisionNo,
            },
            "Meal revision conflict",
          );
        }
        const confirmedNoOpMeal =
          noOpMeal as typeof nutritionMeals.$inferSelect;
        let noOpNutrition = await getNutritionDay(confirmedNoOpMeal.localDate);
        try {
          noOpNutrition = await nutritionForMealRevision(
            db,
            mealId,
            expectedRevisionNo,
            confirmedNoOpMeal.localDate,
            replayMealOverrides(payload),
          );
        } catch {
          // Preserve the existing no-op response if historical rows are unavailable.
        }
        return Response.json({
          mealId,
          revisionNo: expectedRevisionNo,
          requestId: idempotencyKey,
          replay: false,
          unchanged: true,
          nutrition: noOpNutrition,
        });
      }

      const revisionNo = meal.currentRevisionNo + 1;
      const mealRevisionId = `${mealId}|REV|${revisionNo}`;
      const now = new Date().toISOString();
      const revisedItems = currentItems.map((item) => ({
        mealItemId: `${mealRevisionId}|ITEM|${item.itemOrdinal}`,
        mealRevisionId,
        itemOrdinal: item.itemOrdinal,
        foodId: item.foodId,
        foodVersionId: item.foodVersionId,
        itemNameSnapshot: item.itemNameSnapshot,
        quantity: item.quantity,
        unit: item.unit,
        ...pickNutrients(item),
        assumption: item.assumption,
        confidence: item.confidence,
        sourceRow: item.sourceRow,
        dataQualityFlags: item.dataQualityFlags,
      }));
      const itemChunks = chunkByParameterLimit(
        revisedItems,
        mealItemParametersPerRow,
      );
      const comboSourceRows = await db
        .select()
        .from(nutritionMealComboSources)
        .where(
          eq(
            nutritionMealComboSources.mealRevisionId,
            currentRevision.mealRevisionId,
          ),
        )
        .limit(1);
      const comboSource = comboSourceRows[0] ?? null;

      try {
        await db.transaction(async (tx) => {
          const updatedMeals = await tx
            .update(nutritionMeals)
            .set({
              mealType: nextMealType,
              contextTag: nextContextTag,
              originalMealType: nextOriginalMealType,
              currentRevisionNo: revisionNo,
              updatedAt: now,
            })
            .where(
              and(
                eq(nutritionMeals.mealId, mealId),
                eq(nutritionMeals.currentRevisionNo, expectedRevisionNo),
                isNull(nutritionMeals.voidedAt),
              ),
            )
            .returning();
          if (!updatedMeals[0]) throw new MealRevisionWriteConflict();

          await tx.insert(nutritionMealRevisions).values({
            mealRevisionId,
            mealId,
            revisionNo,
            revisionReason:
              payload.revisionReason?.trim() ||
              "Site meal classification correction",
            originalText: currentRevision.originalText,
            notes: currentRevision.notes,
            ...pickNutrients(currentRevision),
            createdBy: actor.id,
          });
          if (comboSource) {
            await tx.insert(nutritionMealComboSources).values({
              mealRevisionId,
              comboVersionId: comboSource.comboVersionId,
            });
          }
          for (const rows of itemChunks) {
            await tx.insert(nutritionMealItems).values(rows);
          }
          await tx.insert(auditLog).values({
            requestId: idempotencyKey,
            actor: actor.id,
            operation: "revise_classification",
            entityType: "nutrition_meal",
            entityId: mealId,
            payloadSha256: digest,
          });
          await tx.insert(auditLog).values(
            revisionReceiptAudit({
              requestId: idempotencyKey,
              actor: actor.id,
              digest,
              mealRevisionId,
            }),
          );
        });
      } catch (error) {
        const concurrentReplayId = await findIdempotentReplay(
          idempotencyKey,
          "nutrition_meal",
          digest,
        );
        if (concurrentReplayId) return replayMealPatch(concurrentReplayId);
        throw error;
      }

      return Response.json({
        mealId,
        revisionNo,
        requestId: idempotencyKey,
        replay: false,
        unchanged: false,
        nutrition: await nutritionForMealRevision(
          db,
          mealId,
          revisionNo,
          meal.localDate,
          replayMealOverrides(payload),
        ),
      });
    }

    if (action === "append_food") {
      const foodId = requiredText(payload.foodId, "foodId");
      const food = await getNutritionFood(foodId);
      if (!food || !food.isActive) {
        return apiError(
          "NUTRITION_FOOD_NOT_FOUND_OR_INACTIVE",
          404,
          { foodId },
          "Nutrition food not found or inactive",
        );
      }
      if (currentItems.some((item) => item.foodId === foodId)) {
        return apiError(
          "MEAL_FOOD_ALREADY_PRESENT",
          409,
          { foodId },
          "Meal food is already present",
        );
      }

      const measure = resolveRegisteredFoodMeasure({
        quantity: quantity!,
        unit: payload.unit,
        baseQuantity: food.baseQuantity,
        baseUnit: food.baseUnit,
      });

      const revisionNo = meal.currentRevisionNo + 1;
      const mealRevisionId = `${mealId}|REV|${revisionNo}`;
      const now = new Date().toISOString();
      const nextOrdinal =
        currentItems.reduce(
          (maximum, item) => Math.max(maximum, item.itemOrdinal),
          0,
        ) + 1;
      const revisedItems = [
        ...currentItems.map((item) => ({
          mealItemId: `${mealRevisionId}|ITEM|${item.itemOrdinal}`,
          mealRevisionId,
          itemOrdinal: item.itemOrdinal,
          foodId: item.foodId,
          foodVersionId: item.foodVersionId,
          itemNameSnapshot: item.itemNameSnapshot,
          quantity: item.quantity,
          unit: item.unit,
          ...pickNutrients(item),
          assumption: item.assumption,
          confidence: item.confidence,
          sourceRow: item.sourceRow,
          dataQualityFlags: item.dataQualityFlags,
        })),
        {
          mealItemId: `${mealRevisionId}|ITEM|${nextOrdinal}`,
          mealRevisionId,
          itemOrdinal: nextOrdinal,
          foodId: food.foodId,
          foodVersionId: food.foodVersionId,
          itemNameSnapshot: food.displayName,
          quantity: measure.quantity,
          unit: measure.unit,
          ...scaleNutrients(
            food.nutrients,
            measure.nutrientScale,
          ),
          assumption: null,
          confidence: "high" as const,
          sourceRow: null,
          dataQualityFlags: null,
        },
      ];
      const totals = sumNutrients(
        revisedItems.map((item) => pickNutrients(item)),
      );
      const itemChunks = chunkByParameterLimit(
        revisedItems,
        mealItemParametersPerRow,
      );

      try {
        await db.transaction(async (tx) => {
          const updatedMeals = await tx
            .update(nutritionMeals)
            .set({
              currentRevisionNo: revisionNo,
              updatedAt: now,
            })
            .where(
              and(
                eq(nutritionMeals.mealId, mealId),
                eq(nutritionMeals.currentRevisionNo, expectedRevisionNo),
                isNull(nutritionMeals.voidedAt),
              ),
            )
            .returning();
          if (!updatedMeals[0]) throw new MealRevisionWriteConflict();

          await tx.insert(nutritionMealRevisions).values({
            mealRevisionId,
            mealId,
            revisionNo,
            revisionReason:
              payload.revisionReason?.trim() || "Site food addition",
            originalText: currentRevision.originalText,
            notes: currentRevision.notes,
            ...totals,
            createdBy: actor.id,
          });
          for (const rows of itemChunks) {
            await tx.insert(nutritionMealItems).values(rows);
          }
          await tx.insert(auditLog).values({
            requestId: idempotencyKey,
            actor: actor.id,
            operation: "append_food",
            entityType: "nutrition_meal",
            entityId: mealId,
            payloadSha256: digest,
          });
          await tx.insert(auditLog).values(
            revisionReceiptAudit({
              requestId: idempotencyKey,
              actor: actor.id,
              digest,
              mealRevisionId,
            }),
          );
        });
      } catch (error) {
        const concurrentReplayId = await findIdempotentReplay(
          idempotencyKey,
          "nutrition_meal",
          digest,
        );
        if (concurrentReplayId) return replayMealPatch(concurrentReplayId);
        throw error;
      }

      return Response.json({
        mealId,
        revisionNo,
        requestId: idempotencyKey,
        replay: false,
        unchanged: false,
        nutrition: await nutritionForMealRevision(
          db,
          mealId,
          revisionNo,
          meal.localDate,
        ),
      });
    }

    const targetItem = currentItems.find(
      (item) => item.mealItemId === mealItemId,
    );
    if (!targetItem) {
      return apiError(
        "MEAL_ITEM_REVISION_CONFLICT",
        409,
        { mealItemId },
        "Meal item is not in the current revision",
      );
    }
    if (targetItem.quantity === null || targetItem.quantity <= 0) {
      return apiError(
        "MEAL_ITEM_QUANTITY_UNAVAILABLE",
        400,
        { mealItemId },
        "Meal item quantity is unavailable",
      );
    }

    if (payload.unit?.trim() && !targetItem.unit) {
      return apiError(
        "MEAL_ITEM_UNIT_UNAVAILABLE",
        400,
        { mealItemId },
        "Meal item unit is unavailable",
      );
    }
    const measure = targetItem.unit
      ? resolveRelativeNutritionMeasure({
          quantity: quantity!,
          unit: payload.unit,
          currentQuantity: targetItem.quantity,
          currentUnit: targetItem.unit,
        })
      : {
          quantity: quantity!,
          unit: targetItem.unit,
          nutrientScale: quantity! / targetItem.quantity,
        };

    if (
      Math.abs(targetItem.quantity - measure.quantity) < 0.000001 &&
      targetItem.unit === measure.unit
    ) {
      let noOpReplayId: string | null = null;
      let noOpMeal: typeof nutritionMeals.$inferSelect | null = null;
      let noOpConflict: number | "voided" | null = null;
      await db.transaction(async (tx) => {
        noOpReplayId = await findIdempotentReplay(
          idempotencyKey,
          "nutrition_meal",
          digest,
          tx,
        );
        if (noOpReplayId) return;
        const latestRows = await tx
          .select()
          .from(nutritionMeals)
          .where(eq(nutritionMeals.mealId, mealId))
          .limit(1);
        const latestMeal = latestRows[0];
        if (!latestMeal) {
          noOpConflict = -1;
          return;
        }
        if (latestMeal.voidedAt) {
          noOpConflict = "voided";
          return;
        }
        if (latestMeal.currentRevisionNo !== expectedRevisionNo) {
          noOpConflict = latestMeal.currentRevisionNo;
          return;
        }
        const latestRevisionRows = await tx
          .select({ mealRevisionId: nutritionMealRevisions.mealRevisionId })
          .from(nutritionMealRevisions)
          .where(
            and(
              eq(nutritionMealRevisions.mealId, mealId),
              eq(
                nutritionMealRevisions.revisionNo,
                latestMeal.currentRevisionNo,
              ),
            ),
          )
          .limit(1);
        const latestRevision = latestRevisionRows[0];
        const latestItemRows = latestRevision
          ? await tx
              .select({ quantity: nutritionMealItems.quantity })
              .from(nutritionMealItems)
              .where(
                and(
                  eq(
                    nutritionMealItems.mealRevisionId,
                    latestRevision.mealRevisionId,
                  ),
                    eq(nutritionMealItems.mealItemId, mealItemId!),
                ),
              )
              .limit(1)
          : [];
        const latestItem = latestItemRows[0];
        if (
          !latestItem ||
          latestItem.quantity === null ||
          Math.abs(latestItem.quantity - quantity!) >= 0.000001
        ) {
          noOpConflict = latestMeal.currentRevisionNo;
          return;
        }
        await tx.insert(auditLog).values({
          requestId: idempotencyKey,
          actor: actor.id,
          operation: "revise_quantity",
          entityType: "nutrition_meal",
          entityId: mealId,
          payloadSha256: digest,
        });
        await tx.insert(auditLog).values(
          revisionReceiptAudit({
            requestId: idempotencyKey,
            actor: actor.id,
            digest,
            mealRevisionId: currentRevision.mealRevisionId,
          }),
        );
        noOpMeal = latestMeal;
      });
      if (noOpReplayId) return replayMealPatch(noOpReplayId);
      if (noOpConflict === "voided") {
        return apiError(
          "MEAL_ALREADY_VOIDED",
          409,
          { mealId },
          "Meal is already voided",
        );
      }
      if (noOpConflict !== null || !noOpMeal) {
        return apiError(
          "MEAL_REVISION_CONFLICT",
          409,
          {
            currentRevisionNo:
              typeof noOpConflict === "number"
                ? noOpConflict
                : meal.currentRevisionNo,
          },
          "Meal revision conflict",
        );
      }
      const confirmedNoOpMeal =
        noOpMeal as typeof nutritionMeals.$inferSelect;
      let noOpNutrition = await getNutritionDay(confirmedNoOpMeal.localDate);
      try {
        noOpNutrition = await nutritionForMealRevision(
          db,
          mealId,
          expectedRevisionNo,
          confirmedNoOpMeal.localDate,
          replayMealOverrides(payload),
        );
      } catch {
        // Preserve the existing no-op response if historical rows are unavailable.
      }
      return Response.json({
        mealId,
        revisionNo: expectedRevisionNo,
        requestId: idempotencyKey,
        replay: false,
        unchanged: true,
        nutrition: noOpNutrition,
      });
    }

    const revisionNo = meal.currentRevisionNo + 1;
    const mealRevisionId = `${mealId}|REV|${revisionNo}`;
    const now = new Date().toISOString();
    const revisedItems = currentItems.map((item) => {
      const isTarget = item.mealItemId === mealItemId;
      const nextQuantity = isTarget ? measure.quantity : item.quantity;
      const nutrients = isTarget
        ? scaleNutrients(
            pickNutrients(item),
            measure.nutrientScale,
          )
        : pickNutrients(item);
      return {
        mealItemId: `${mealRevisionId}|ITEM|${item.itemOrdinal}`,
        mealRevisionId,
        itemOrdinal: item.itemOrdinal,
        foodId: item.foodId,
        foodVersionId: item.foodVersionId,
        itemNameSnapshot: item.itemNameSnapshot,
        quantity: nextQuantity,
        unit: isTarget ? measure.unit : item.unit,
        ...nutrients,
        assumption: item.assumption,
        confidence: item.confidence,
        sourceRow: item.sourceRow,
        dataQualityFlags: item.dataQualityFlags,
      };
    });
    const totals = sumNutrients(
      revisedItems.map((item) => pickNutrients(item)),
    );

    const itemChunks = chunkByParameterLimit(
      revisedItems,
      mealItemParametersPerRow,
    );

    try {
      await db.transaction(async (tx) => {
        const updatedMeals = await tx
          .update(nutritionMeals)
          .set({
            currentRevisionNo: revisionNo,
            updatedAt: now,
          })
          .where(
            and(
              eq(nutritionMeals.mealId, mealId),
              eq(nutritionMeals.currentRevisionNo, expectedRevisionNo),
              isNull(nutritionMeals.voidedAt),
            ),
          )
          .returning();
        if (!updatedMeals[0]) throw new MealRevisionWriteConflict();

        await tx.insert(nutritionMealRevisions).values({
          mealRevisionId,
          mealId,
          revisionNo,
          revisionReason:
            payload.revisionReason?.trim() || "Site quantity correction",
          originalText: currentRevision.originalText,
          notes: currentRevision.notes,
          ...totals,
          createdBy: actor.id,
        });
        for (const rows of itemChunks) {
          await tx.insert(nutritionMealItems).values(rows);
        }
        await tx.insert(auditLog).values({
          requestId: idempotencyKey,
          actor: actor.id,
          operation: "revise_quantity",
          entityType: "nutrition_meal",
          entityId: mealId,
          payloadSha256: digest,
        });
        await tx.insert(auditLog).values(
          revisionReceiptAudit({
            requestId: idempotencyKey,
            actor: actor.id,
            digest,
            mealRevisionId,
          }),
        );
      });
    } catch (error) {
      const concurrentReplayId = await findIdempotentReplay(
        idempotencyKey,
        "nutrition_meal",
        digest,
      );
      if (concurrentReplayId) return replayMealPatch(concurrentReplayId);
      throw error;
    }

    return Response.json({
      mealId,
      revisionNo,
      requestId: idempotencyKey,
      replay: false,
      unchanged: false,
      nutrition: await nutritionForMealRevision(
        db,
        mealId,
        revisionNo,
        meal.localDate,
      ),
    });
  } catch (error) {
    return mealRouteError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const payload = (await request.json()) as MealItemDeleteInput;
    const mealId = requiredText(payload.mealId, "mealId");
    const deleteWholeMeal = payload.deleteMeal === true;
    const mealItemId = deleteWholeMeal
      ? null
      : requiredText(payload.mealItemId, "mealItemId");
    const expectedRevisionNo = finiteNumber(payload.expectedRevisionNo, {
      min: 1,
    });
    if (
      expectedRevisionNo === null ||
      !Number.isInteger(expectedRevisionNo)
    ) {
      return apiError(
        "INVALID_MEAL_REVISION",
        400,
        { field: "expectedRevisionNo" },
        "Invalid meal revision number",
      );
    }

    const db = getDb();
    const mealRows = await db
      .select()
      .from(nutritionMeals)
      .where(eq(nutritionMeals.mealId, mealId))
      .limit(1);
    const meal = mealRows[0] ?? null;
    if (!meal) {
      return apiError(
        "MEAL_NOT_FOUND",
        404,
        { mealId },
        "Meal not found",
      );
    }

    const idempotencyKey = requestId(request);
    const digest = await payloadSha256(payload);
    const replayedId = await findIdempotentReplay(
      idempotencyKey,
      "nutrition_meal",
      digest,
    );
    const replayMealDelete = async (replayedMealId: string) => {
      if (replayedMealId !== mealId) {
        throw new Error("Nutrition meal deletion replay is unavailable");
      }
      const receiptRevisionId = await findIdempotentReplay(
        idempotencyKey,
        "nutrition_meal_revision",
        digest,
      );
      const replayRevisionId =
        receiptRevisionId ?? `${mealId}|REV|${expectedRevisionNo + 1}`;
      const revisionRows = await db
        .select({ revisionNo: nutritionMealRevisions.revisionNo })
        .from(nutritionMealRevisions)
        .where(
          and(
            eq(nutritionMealRevisions.mealId, mealId),
            eq(nutritionMealRevisions.mealRevisionId, replayRevisionId),
          ),
        )
        .limit(1);
      const replayRevision = revisionRows[0];
      if (!replayRevision) {
        throw new Error("Nutrition meal deletion replay is unavailable");
      }
      const replayItems = await db
        .select({ mealItemId: nutritionMealItems.mealItemId })
        .from(nutritionMealItems)
        .where(eq(nutritionMealItems.mealRevisionId, replayRevisionId));
      const deletedMeal = replayItems.length === 0;
      let nutrition = await getNutritionDay(meal.localDate);
      if (!deletedMeal) {
        nutrition = await nutritionForMealRevision(
          db,
          mealId,
          replayRevision.revisionNo,
          meal.localDate,
        );
      }
      return Response.json({
        mealId,
        revisionNo: replayRevision.revisionNo,
        requestId: idempotencyKey,
        replay: true,
        deletedMeal,
        nutrition,
      });
    };
    if (replayedId) {
      return replayMealDelete(replayedId);
    }

    if (meal.currentRevisionNo !== expectedRevisionNo) {
      return apiError(
        "MEAL_REVISION_CONFLICT",
        409,
        { currentRevisionNo: meal.currentRevisionNo },
        "Meal revision conflict",
      );
    }
    if (meal.voidedAt) {
      return apiError(
        "MEAL_ALREADY_VOIDED",
        409,
        { mealId, voidedAt: meal.voidedAt },
        "Meal is already voided",
      );
    }

    const revisionRows = await db
      .select()
      .from(nutritionMealRevisions)
      .where(
        and(
          eq(nutritionMealRevisions.mealId, mealId),
          eq(
            nutritionMealRevisions.revisionNo,
            meal.currentRevisionNo,
          ),
        ),
      )
      .limit(1);
    const currentRevision = revisionRows[0] ?? null;
    if (!currentRevision) {
      return apiError(
        "MEAL_REVISION_NOT_FOUND",
        409,
        { mealId, revisionNo: meal.currentRevisionNo },
        "Meal revision not found",
      );
    }

    const currentItems = await db
      .select()
      .from(nutritionMealItems)
      .where(
        eq(
          nutritionMealItems.mealRevisionId,
          currentRevision.mealRevisionId,
        ),
      )
      .orderBy(asc(nutritionMealItems.itemOrdinal));
    if (
      !deleteWholeMeal &&
      !currentItems.some((item) => item.mealItemId === mealItemId)
    ) {
      return apiError(
        "MEAL_ITEM_REVISION_CONFLICT",
        409,
        { mealItemId },
        "Meal item is not in the current revision",
      );
    }

    const revisionNo = meal.currentRevisionNo + 1;
    const mealRevisionId = `${mealId}|REV|${revisionNo}`;
    const now = new Date().toISOString();
    const revisedItems = currentItems
      .filter(
        (item) => !deleteWholeMeal && item.mealItemId !== mealItemId,
      )
      .map((item, index) => ({
        mealItemId: `${mealRevisionId}|ITEM|${index + 1}`,
        mealRevisionId,
        itemOrdinal: index + 1,
        foodId: item.foodId,
        foodVersionId: item.foodVersionId,
        itemNameSnapshot: item.itemNameSnapshot,
        quantity: item.quantity,
        unit: item.unit,
        ...pickNutrients(item),
        assumption: item.assumption,
        confidence: item.confidence,
        sourceRow: item.sourceRow,
        dataQualityFlags: item.dataQualityFlags,
      }));
    const totals = sumNutrients(
      revisedItems.map((item) => pickNutrients(item)),
    );

    const itemChunks = chunkByParameterLimit(
      revisedItems,
      mealItemParametersPerRow,
    );
    try {
      await db.transaction(async (tx) => {
        const updatedMeals = await tx
          .update(nutritionMeals)
          .set({
            currentRevisionNo: revisionNo,
            voidedAt: revisedItems.length === 0 ? now : null,
            updatedAt: now,
          })
          .where(
            and(
              eq(nutritionMeals.mealId, mealId),
              eq(nutritionMeals.currentRevisionNo, expectedRevisionNo),
              isNull(nutritionMeals.voidedAt),
            ),
          )
          .returning();
        if (!updatedMeals[0]) throw new MealRevisionWriteConflict();

        await tx.insert(nutritionMealRevisions).values({
          mealRevisionId,
          mealId,
          revisionNo,
          revisionReason:
            payload.revisionReason?.trim() ||
            (deleteWholeMeal ? "Site meal undo" : "Site item deletion"),
          originalText: currentRevision.originalText,
          notes: currentRevision.notes,
          ...totals,
          createdBy: actor.id,
        });
        for (const rows of itemChunks) {
          await tx.insert(nutritionMealItems).values(rows);
        }
        await tx.insert(auditLog).values({
          requestId: idempotencyKey,
          actor: actor.id,
          operation: deleteWholeMeal ? "void" : "delete_item",
          entityType: "nutrition_meal",
          entityId: mealId,
          payloadSha256: digest,
        });
        await tx.insert(auditLog).values(
          revisionReceiptAudit({
            requestId: idempotencyKey,
            actor: actor.id,
            digest,
            mealRevisionId,
          }),
        );
      });
    } catch (error) {
      const concurrentReplayId = await findIdempotentReplay(
        idempotencyKey,
        "nutrition_meal",
        digest,
      );
      if (concurrentReplayId) return replayMealDelete(concurrentReplayId);
      throw error;
    }
    const deletedMeal = revisedItems.length === 0;
    const nutrition = deletedMeal
      ? await getNutritionDay(meal.localDate)
      : await nutritionForMealRevision(
          db,
          mealId,
          revisionNo,
          meal.localDate,
        );
    return Response.json({
      mealId,
      revisionNo,
      requestId: idempotencyKey,
      replay: false,
      deletedMeal,
      nutrition,
    });
  } catch (error) {
    return mealRouteError(error);
  }
}
