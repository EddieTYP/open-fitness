import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import {
  auditLog,
  nutritionMealItems,
  nutritionMealPlanItems,
  nutritionMealPlans,
  nutritionMealRevisions,
  nutritionMeals,
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
  getNutritionMealPlan,
  listPendingNutritionMealPlans,
  type NutritionMealPlanView,
} from "@/lib/nutrition-plans";
import {
  finiteNumber,
  isDateOnly,
  payloadSha256,
  rejectUnknownFields,
  requestId,
  requiredText,
} from "@/lib/record-utils";
import { getProfileTimezone } from "@/lib/profile-timezone";
import { dateInTimeZone } from "@/lib/timezone.mjs";

export const dynamic = "force-dynamic";

class PlanWriteConflict extends Error {}

function planRouteError(error: unknown) {
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
  if (error instanceof PlanWriteConflict) {
    return apiError(
      "PLAN_VERSION_CONFLICT",
      409,
      {},
      "Plan version conflict",
    );
  }
  return routeError(error);
}

type MealType = NutritionMealView["mealType"];
type Confidence = "high" | "medium" | "low";

type PlanItemInput = {
  planItemId?: string;
  foodId?: string;
  name?: string;
  quantity?: number;
  unit?: string;
  confidence?: Confidence;
  assumption?: string | null;
  nutrients?: Partial<Record<NutrientKey, number | null>>;
  dataQualityFlags?: string | null;
};

type PlanInput = {
  planId?: string;
  scheduledDate?: string | null;
  scheduledDates?: string[];
  mealType?: MealType;
  contextTag?: string | null;
  originalMealType?: string | null;
  source?: string;
  confidence?: Confidence;
  originalText?: string | null;
  items?: PlanItemInput[];
};

type PlanPatchInput = PlanInput & {
  action?: "revise" | "consume" | "undo_consume";
  expectedVersionNo?: number;
};

type PlanDeleteInput = {
  planId?: string;
  expectedVersionNo?: number;
};

type CurrentPlanItem = typeof nutritionMealPlanItems.$inferSelect;
type NormalizedPlanItem = {
  foodId: string | null;
  foodVersionId: string | null;
  name: string;
  quantity: number;
  unit: string;
  nutrients: Nutrients;
  assumption: string | null;
  confidence: Confidence;
  dataQualityFlags: string | null;
};
type PlanReplayReadDb = Pick<ReturnType<typeof getDb>, "select">;

const mealTypes = new Set<MealType>([
  "breakfast",
  "lunch",
  "dinner",
  "snack",
  "late_night",
  "other",
]);
const confidenceValues = new Set<Confidence>(["high", "medium", "low"]);
const planItemFields = new Set([
  "planItemId",
  "foodId",
  "name",
  "quantity",
  "unit",
  "confidence",
  "assumption",
  "nutrients",
  "dataQualityFlags",
]);
const planNutrientFields = new Set<string>(nutrientKeys);
const itemParametersPerRow = 22;
const planParametersPerRow = 12;
const auditParametersPerRow = 6;

function parseExpectedVersion(value: unknown) {
  const parsed = finiteNumber(value, { min: 1 });
  if (parsed === null || !Number.isInteger(parsed)) {
    throw new Error("expectedVersionNo must be a positive integer");
  }
  return parsed;
}

function parseScheduledDate(
  value: string | null | undefined,
  fallback: string | null,
) {
  if (value === undefined) return fallback;
  if (value === null || value === "") return null;
  if (!isDateOnly(value)) throw new Error("scheduledDate must use YYYY-MM-DD");
  return value;
}

function parseScheduledDates(input: PlanInput) {
  if (input.scheduledDates === undefined) {
    return [parseScheduledDate(input.scheduledDate, null)];
  }
  if (input.scheduledDate !== undefined) {
    throw new Error("Use either scheduledDate or scheduledDates");
  }
  if (
    !Array.isArray(input.scheduledDates) ||
    input.scheduledDates.length < 1 ||
    input.scheduledDates.length > 14
  ) {
    throw new Error("scheduledDates must contain between 1 and 14 dates");
  }
  const dates = input.scheduledDates.map((value) => {
    if (!isDateOnly(value)) {
      throw new Error("scheduledDates must use YYYY-MM-DD");
    }
    return value;
  });
  if (new Set(dates).size !== dates.length) {
    throw new Error("scheduledDates must not contain duplicates");
  }
  return dates;
}

function parseEstimatedNutrients(
  value: PlanItemInput["nutrients"],
): Nutrients {
  if (!value) throw new Error("nutrients is required");
  const result = nullNutrients();
  for (const key of nutrientKeys) {
    result[key] = finiteNumber(value[key], {
      min: 0,
      max: key === "sodiumMg" ? 100000 : 50000,
      optional: true,
    });
  }
  if (result.energyKcal === null) throw new Error("energyKcal is required");
  return result;
}

function parseClassification(
  input: {
    mealType?: MealType;
    contextTag?: string | null;
    originalMealType?: string | null;
  },
  fallback?: {
    mealType: string;
    contextTag: string | null;
    originalMealType: string | null;
  },
) {
  const mealType = input.mealType ?? (fallback?.mealType as MealType | undefined);
  if (!mealType || !mealTypes.has(mealType)) {
    throw new Error("Invalid mealType");
  }
  const contextTag =
    input.contextTag === undefined
      ? fallback?.contextTag ?? null
      : input.contextTag?.trim() || null;
  const originalMealType =
    input.originalMealType === undefined
      ? fallback?.originalMealType ?? null
      : input.originalMealType?.trim() || null;
  return validateMealClassification({
    mealType,
    contextTag,
    originalMealType,
  });
}

async function normalizeItems(
  inputs: PlanItemInput[],
  defaultConfidence: Confidence,
  currentItems: CurrentPlanItem[] = [],
): Promise<NormalizedPlanItem[]> {
  if (inputs.length === 0 || inputs.length > 60) {
    throw new Error("items must contain between 1 and 60 records");
  }
  const currentById = new Map(
    currentItems.map((item) => [item.planItemId, item]),
  );
  const usedCurrentIds = new Set<string>();
  const normalized: NormalizedPlanItem[] = [];

  for (const [index, item] of inputs.entries()) {
    rejectUnknownFields(item, planItemFields, `items[${index}]`);
    if (item.nutrients !== undefined) {
      rejectUnknownFields(
        item.nutrients,
        planNutrientFields,
        `items[${index}].nutrients`,
      );
    }
    if (
      item.dataQualityFlags !== undefined &&
      item.dataQualityFlags !== null &&
      typeof item.dataQualityFlags !== "string"
    ) {
      throw new Error(`Invalid items[${index}].dataQualityFlags`);
    }
    const confidence = item.confidence ?? defaultConfidence;
    if (!confidenceValues.has(confidence)) {
      throw new Error(`Invalid confidence for items[${index}]`);
    }

    if (item.planItemId) {
      const current = currentById.get(item.planItemId);
      if (!current || usedCurrentIds.has(item.planItemId)) {
        throw new Error("Plan item is not part of the current version");
      }
      usedCurrentIds.add(item.planItemId);
      requireQuantityForExplicitNutritionUnit({
        quantity: item.quantity,
        unit: item.unit,
        basisUnit: current.unit,
      });
      const quantity = finiteNumber(item.quantity ?? current.quantity, {
        min: 0.001,
        max: 100000,
      })!;
      const measure = resolveRelativeNutritionMeasure({
        quantity,
        unit: item.unit,
        currentQuantity: current.quantity,
        currentUnit: current.unit,
      });
      normalized.push({
        foodId: current.foodId,
        foodVersionId: current.foodVersionId,
        name: current.itemNameSnapshot,
        quantity: measure.quantity,
        unit: measure.unit,
        nutrients: scaleNutrients(
          pickNutrients(current),
          measure.nutrientScale,
        ),
        assumption: current.assumption,
        confidence: current.confidence as Confidence,
        dataQualityFlags: current.dataQualityFlags,
      });
      continue;
    }

    if (item.foodId) {
      const food = await getNutritionFood(item.foodId);
      if (!food || !food.isActive) {
        throw new Error(`Food item not found or inactive: ${item.foodId}`);
      }
      requireQuantityForExplicitNutritionUnit({
        quantity: item.quantity,
        unit: item.unit,
        basisUnit: food.baseUnit,
      });
      const quantity = finiteNumber(item.quantity ?? food.baseQuantity, {
        min: 0.001,
        max: 100000,
      })!;
      const measure = resolveRegisteredFoodMeasure({
        quantity,
        unit: item.unit,
        baseQuantity: food.baseQuantity,
        baseUnit: food.baseUnit,
      });
      normalized.push({
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
        confidence,
        dataQualityFlags: null,
      });
      continue;
    }

    normalized.push({
      foodId: null,
      foodVersionId: null,
      name: requiredText(item.name, `items[${index}].name`),
      quantity: finiteNumber(item.quantity, {
        min: 0.001,
        max: 100000,
      })!,
      unit: requiredText(item.unit, `items[${index}].unit`),
      nutrients: parseEstimatedNutrients(item.nutrients),
      assumption: item.assumption?.trim() || null,
      confidence,
      dataQualityFlags: "estimated",
    });
  }
  return normalized;
}

function planItemRows(
  planId: string,
  versionNo: number,
  items: NormalizedPlanItem[],
) {
  return items.map((item, index) => ({
    planItemId: `${planId}|V${versionNo}|ITEM|${index + 1}`,
    planId,
    itemOrdinal: index + 1,
    foodId: item.foodId,
    foodVersionId: item.foodVersionId,
    itemNameSnapshot: item.name,
    quantity: item.quantity,
    unit: item.unit,
    ...item.nutrients,
    assumption: item.assumption,
    confidence: item.confidence,
    dataQualityFlags: item.dataQualityFlags,
  }));
}

async function currentPlanItems(planId: string) {
  return getDb()
    .select()
    .from(nutritionMealPlanItems)
    .where(eq(nutritionMealPlanItems.planId, planId))
    .orderBy(asc(nutritionMealPlanItems.itemOrdinal));
}

async function findPlanCreateReplay(
  idempotencyKey: string,
  digest: string,
  db: PlanReplayReadDb = getDb(),
) {
  const rows = await db
    .select({
      auditId: auditLog.auditId,
      entityId: auditLog.entityId,
      payloadSha256: auditLog.payloadSha256,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.requestId, idempotencyKey),
        eq(auditLog.entityType, "nutrition_plan"),
      ),
    )
    .orderBy(asc(auditLog.auditId));
  if (rows.some((row) => row.payloadSha256 !== digest)) {
    throw new Error("Idempotency key conflict");
  }
  return rows.length ? rows.map((row) => row.entityId) : null;
}

async function replayedPlanMealId(
  idempotencyKey: string,
  digest: string,
) {
  const mealId = await findIdempotentReplay(
    idempotencyKey,
    "nutrition_meal",
    digest,
  );
  if (!mealId) {
    throw new Error("Plan mutation replay receipt is unavailable");
  }
  return mealId;
}

async function historicalPlanFromMeal(input: {
  planId: string;
  mealId: string;
  itemVersionNo: number;
  versionNo: number;
  status: "pending" | "consumed";
}) {
  const db = getDb();
  const [planRows, mealRows, revisionRows, itemRows] = await Promise.all([
    db
      .select({ source: nutritionMealPlans.source })
      .from(nutritionMealPlans)
      .where(eq(nutritionMealPlans.planId, input.planId))
      .limit(1),
    db
      .select()
      .from(nutritionMeals)
      .where(eq(nutritionMeals.mealId, input.mealId))
      .limit(1),
    db
      .select()
      .from(nutritionMealRevisions)
      .where(
        and(
          eq(nutritionMealRevisions.mealId, input.mealId),
          eq(nutritionMealRevisions.revisionNo, 1),
        ),
      )
      .limit(1),
    db
      .select()
      .from(nutritionMealItems)
      .where(
        eq(nutritionMealItems.mealRevisionId, `${input.mealId}|REV|1`),
      )
      .orderBy(asc(nutritionMealItems.itemOrdinal)),
  ]);
  const storedPlan = planRows[0] ?? null;
  const meal = mealRows[0] ?? null;
  const revision = revisionRows[0] ?? null;
  if (
    !storedPlan ||
    !meal ||
    !revision ||
    meal.source !== "site_planned_meal" ||
    itemRows.length === 0 ||
    itemRows.some((item) => item.quantity === null || item.unit === null)
  ) {
    throw new Error("Plan mutation replay receipt is unavailable");
  }
  const items: NutritionMealPlanView["items"] = itemRows.map((item) => ({
    planItemId: `${input.planId}|V${input.itemVersionNo}|ITEM|${item.itemOrdinal}`,
    name: item.itemNameSnapshot,
    quantity: item.quantity!,
    unit: item.unit!,
    foodId: item.foodId,
    nutrients: pickNutrients(item),
    assumption: item.assumption,
    confidence: item.confidence as NutritionMealPlanView["items"][number]["confidence"],
    dataQualityFlags: item.dataQualityFlags,
  }));
  const plan: NutritionMealPlanView = {
    planId: input.planId,
    scheduledDate: meal.localDate,
    mealType: meal.mealType as NutritionMealPlanView["mealType"],
    contextTag: meal.contextTag,
    originalMealType: meal.originalMealType,
    source: storedPlan.source,
    confidence: meal.confidence as NutritionMealPlanView["confidence"],
    originalText: revision.originalText,
    status: input.status,
    versionNo: input.versionNo,
    completedMealId: input.status === "consumed" ? input.mealId : null,
    nutrients: sumNutrients(items.map((item) => item.nutrients)),
    items,
  };
  return { plan, scheduledDate: meal.localDate };
}

async function replayPlanAction(input: {
  action: "consume" | "undo_consume";
  planId: string;
  expectedVersionNo: number;
  idempotencyKey: string;
  digest: string;
}) {
  const mealId = await replayedPlanMealId(input.idempotencyKey, input.digest);
  const versionNo = input.expectedVersionNo + 1;
  const revisionNo = input.action === "consume" ? 1 : 2;
  const { plan, scheduledDate } = await historicalPlanFromMeal({
    planId: input.planId,
    mealId,
    itemVersionNo:
      input.action === "consume"
        ? input.expectedVersionNo
        : input.expectedVersionNo - 1,
    versionNo,
    status: input.action === "consume" ? "consumed" : "pending",
  });
  if (input.action === "undo_consume") {
    const undoneRows = await getDb()
      .select({ revisionNo: nutritionMealRevisions.revisionNo })
      .from(nutritionMealRevisions)
      .where(
        and(
          eq(nutritionMealRevisions.mealId, mealId),
          eq(nutritionMealRevisions.revisionNo, revisionNo),
        ),
      )
      .limit(1);
    if (!undoneRows[0]) {
      throw new Error("Plan mutation replay receipt is unavailable");
    }
  }
  return Response.json({
    planId: input.planId,
    versionNo,
    mealId,
    revisionNo,
    requestId: input.idempotencyKey,
    replay: true,
    plan,
    plans: await listPendingNutritionMealPlans(),
    nutrition: await getNutritionDay(scheduledDate),
  });
}

export async function GET(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    return Response.json(
      { plans: await listPendingNutritionMealPlans() },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return planRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const payload = (await request.json()) as PlanInput;
    const classification = parseClassification(payload);
    const scheduledDates = parseScheduledDates(payload);
    const confidence = payload.confidence ?? "medium";
    if (!confidenceValues.has(confidence)) {
      return apiError(
        "INVALID_PLAN_CONFIDENCE",
        400,
        { confidence, allowedConfidenceValues: [...confidenceValues] },
        "Invalid plan confidence",
      );
    }
    if (scheduledDates.length > 1 && payload.planId?.trim()) {
      return apiError(
        "PLAN_ID_WITH_MULTIPLE_DATES",
        400,
        { field: "planId" },
        "Plan ID is not supported for multiple dates",
      );
    }
    const planIds = scheduledDates.map((_, index) =>
      index === 0 && payload.planId?.trim()
        ? payload.planId.trim()
        : `PLAN|${crypto.randomUUID()}`,
    );
    const idempotencyKey = requestId(request);
    const digest = await payloadSha256(payload);
    const replayedIds = await findPlanCreateReplay(idempotencyKey, digest);
    if (replayedIds) {
      return Response.json({
        planId: replayedIds[0],
        planIds: replayedIds,
        requestId: idempotencyKey,
        replay: true,
        plan: await getNutritionMealPlan(replayedIds[0]),
        plans: await listPendingNutritionMealPlans(),
      });
    }

    const db = getDb();
    const items = await normalizeItems(payload.items ?? [], confidence);
    if (scheduledDates.length > 1 && items.length > 20) {
      return apiError(
        "MULTIPLE_DATE_PLAN_ITEM_LIMIT_EXCEEDED",
        400,
        { itemCount: items.length, maximumItems: 20 },
        "Multiple-date plan item limit exceeded",
      );
    }
    const allItemRows = planIds.flatMap((planId) =>
      planItemRows(planId, 1, items),
    );
    const itemChunks = chunkByParameterLimit(
      allItemRows,
      itemParametersPerRow,
    );
    const now = new Date().toISOString();
    const source =
      payload.source?.trim() ||
      (actor.kind === "fitness-agent" ? "chat_plan" : "site_plan");
    const planRows = planIds.map((planId, index) => ({
      planId,
      scheduledDate: scheduledDates[index],
      ...classification,
      source,
      confidence,
      originalText: payload.originalText?.trim() || null,
      status: "pending",
      currentVersionNo: 1,
      createdBy: actor.id,
      updatedAt: now,
    }));
    const planChunks = chunkByParameterLimit(
      planRows,
      planParametersPerRow,
    );
    const auditRows = planIds.map((planId) => ({
      requestId: idempotencyKey,
      actor: actor.id,
      operation: "insert",
      entityType: "nutrition_plan",
      entityId: planId,
      payloadSha256: digest,
    }));
    const auditChunks = chunkByParameterLimit(
      auditRows,
      auditParametersPerRow,
    );

    let writeResult:
      | { kind: "created" | "replay"; planIds: string[] }
      | { kind: "duplicate"; planId: string };
    try {
      writeResult = await db.transaction(async (tx) => {
        const concurrentReplayIds = await findPlanCreateReplay(
          idempotencyKey,
          digest,
          tx,
        );
        if (concurrentReplayIds) {
          return { kind: "replay", planIds: concurrentReplayIds } as const;
        }

        const duplicate = await tx
          .select({ planId: nutritionMealPlans.planId })
          .from(nutritionMealPlans)
          .where(eq(nutritionMealPlans.planId, planIds[0]))
          .limit(1);
        if (duplicate[0]) {
          return { kind: "duplicate", planId: duplicate[0].planId } as const;
        }

        for (const rows of planChunks) {
          await tx.insert(nutritionMealPlans).values(rows);
        }
        for (const rows of itemChunks) {
          await tx.insert(nutritionMealPlanItems).values(rows);
        }
        for (const rows of auditChunks) {
          await tx.insert(auditLog).values(rows);
        }
        return { kind: "created", planIds } as const;
      });
    } catch (error) {
      const concurrentReplayIds = await findPlanCreateReplay(
        idempotencyKey,
        digest,
      );
      if (!concurrentReplayIds) throw error;
      writeResult = { kind: "replay", planIds: concurrentReplayIds };
    }
    if (writeResult.kind === "duplicate") {
      return apiError(
        "PLAN_ID_ALREADY_EXISTS",
        409,
        { planId: writeResult.planId },
        "Plan ID already exists",
      );
    }
    const storedPlanIds = writeResult.planIds;

    return Response.json(
      {
        planId: storedPlanIds[0],
        planIds: storedPlanIds,
        versionNo: 1,
        requestId: idempotencyKey,
        replay: writeResult.kind === "replay",
        plan: await getNutritionMealPlan(storedPlanIds[0]),
        plans: await listPendingNutritionMealPlans(),
      },
      { status: writeResult.kind === "replay" ? 200 : 201 },
    );
  } catch (error) {
    return planRouteError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const payload = (await request.json()) as PlanPatchInput;
    const planId = requiredText(payload.planId, "planId");
    const expectedVersionNo = parseExpectedVersion(payload.expectedVersionNo);
    const action = payload.action ?? "revise";
    if (!["revise", "consume", "undo_consume"].includes(action)) {
      return apiError(
        "INVALID_PLAN_ACTION",
        400,
        { action, allowedActions: ["revise", "consume", "undo_consume"] },
        "Invalid plan action",
      );
    }

    const db = getDb();
    const planRows = await db
      .select()
      .from(nutritionMealPlans)
      .where(eq(nutritionMealPlans.planId, planId))
      .limit(1);
    const plan = planRows[0] ?? null;
    if (!plan) {
      return apiError("PLAN_NOT_FOUND", 404, { planId }, "Plan not found");
    }

    const idempotencyKey = requestId(request);
    const digest = await payloadSha256(payload);
    const replayedId = await findIdempotentReplay(
      idempotencyKey,
      "nutrition_plan",
      digest,
    );
    if (replayedId) {
      if (replayedId !== planId) {
        throw new Error("Plan mutation replay is unavailable");
      }
      if (action === "consume" || action === "undo_consume") {
        return replayPlanAction({
          action,
          planId,
          expectedVersionNo,
          idempotencyKey,
          digest,
        });
      }
      const replayedPlan = await getNutritionMealPlan(replayedId);
      return Response.json({
        planId: replayedId,
        versionNo: replayedPlan?.versionNo ?? plan.currentVersionNo,
        mealId: replayedPlan?.completedMealId ?? null,
        requestId: idempotencyKey,
        replay: true,
        plan: replayedPlan,
        plans: await listPendingNutritionMealPlans(),
        nutrition: plan.scheduledDate
          ? await getNutritionDay(plan.scheduledDate)
          : null,
      });
    }
    if (plan.currentVersionNo !== expectedVersionNo) {
      return apiError(
        "PLAN_VERSION_CONFLICT",
        409,
        { currentVersionNo: plan.currentVersionNo },
        "Plan version conflict",
      );
    }

    if (action === "revise") {
      if (plan.status !== "pending") {
        return apiError(
          "PLAN_NOT_PENDING",
          409,
          { status: plan.status },
          "Plan is not pending",
        );
      }
      const confidence = payload.confidence ?? (plan.confidence as Confidence);
      if (!confidenceValues.has(confidence)) {
        return apiError(
          "INVALID_PLAN_CONFIDENCE",
          400,
          { confidence, allowedConfidenceValues: [...confidenceValues] },
          "Invalid plan confidence",
        );
      }
      const classification = parseClassification(payload, plan);
      const scheduledDate = parseScheduledDate(
        payload.scheduledDate,
        plan.scheduledDate,
      );
      const existingItems = await currentPlanItems(planId);
      const items = payload.items
        ? await normalizeItems(payload.items, confidence, existingItems)
        : existingItems.map((item) => ({
            foodId: item.foodId,
            foodVersionId: item.foodVersionId,
            name: item.itemNameSnapshot,
            quantity: item.quantity,
            unit: item.unit,
            nutrients: pickNutrients(item),
            assumption: item.assumption,
            confidence: item.confidence as Confidence,
            dataQualityFlags: item.dataQualityFlags,
          }));
      const versionNo = plan.currentVersionNo + 1;
      const itemRows = planItemRows(planId, versionNo, items);
      const itemChunks = chunkByParameterLimit(
        itemRows,
        itemParametersPerRow,
      );

      try {
        await db.transaction(async (tx) => {
          const updatedPlans = await tx
            .update(nutritionMealPlans)
            .set({
              scheduledDate,
              ...classification,
              confidence,
              originalText:
                payload.originalText === undefined
                  ? plan.originalText
                  : payload.originalText?.trim() || null,
              currentVersionNo: versionNo,
              updatedAt: new Date().toISOString(),
            })
            .where(
              and(
                eq(nutritionMealPlans.planId, planId),
                eq(nutritionMealPlans.currentVersionNo, expectedVersionNo),
                eq(nutritionMealPlans.status, "pending"),
              ),
            )
            .returning({ currentVersionNo: nutritionMealPlans.currentVersionNo });
          if (!updatedPlans[0]) throw new PlanWriteConflict();

          await tx
            .delete(nutritionMealPlanItems)
            .where(eq(nutritionMealPlanItems.planId, planId));
          for (const rows of itemChunks) {
            await tx.insert(nutritionMealPlanItems).values(rows);
          }
          await tx.insert(auditLog).values({
            requestId: idempotencyKey,
            actor: actor.id,
            operation: "revise",
            entityType: "nutrition_plan",
            entityId: planId,
            payloadSha256: digest,
          });
        });
      } catch (error) {
        const concurrentReplayId = await findIdempotentReplay(
          idempotencyKey,
          "nutrition_plan",
          digest,
        );
        if (!concurrentReplayId) throw error;
        if (concurrentReplayId !== planId) {
          throw new Error("Plan revision replay is unavailable");
        }
        const replayedPlan = await getNutritionMealPlan(planId);
        return Response.json({
          planId,
          versionNo: replayedPlan?.versionNo ?? versionNo,
          requestId: idempotencyKey,
          replay: true,
          plan: replayedPlan,
          plans: await listPendingNutritionMealPlans(),
        });
      }

      return Response.json({
        planId,
        versionNo,
        requestId: idempotencyKey,
        replay: false,
        plan: await getNutritionMealPlan(planId),
        plans: await listPendingNutritionMealPlans(),
      });
    }

    if (action === "consume") {
      if (plan.status !== "pending") {
        return apiError(
          "PLAN_NOT_PENDING",
          409,
          { status: plan.status },
          "Plan is not pending",
        );
      }
      if (!plan.scheduledDate) {
        return apiError(
          "PLAN_SCHEDULE_DATE_REQUIRED",
          400,
          { field: "scheduledDate" },
          "Plan schedule date is required",
        );
      }
      const today = dateInTimeZone(new Date(), await getProfileTimezone());
      if (plan.scheduledDate > today) {
        return apiError(
          "PLAN_SCHEDULE_DATE_IN_FUTURE",
          409,
          { scheduledDate: plan.scheduledDate, today },
          "Plan schedule date is in the future",
        );
      }
      const scheduledDate = plan.scheduledDate;
      const items = await currentPlanItems(planId);
      if (items.length === 0) {
        return apiError(
          "PLAN_HAS_NO_ITEMS",
          409,
          { planId },
          "Plan has no items",
        );
      }
      const mealId = `MEAL|${crypto.randomUUID()}`;
      const mealRevisionId = `${mealId}|REV|1`;
      const mealItems = items.map((item, index) => ({
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
        dataQualityFlags: item.dataQualityFlags,
      }));
      const totals = sumNutrients(
        mealItems.map((item) => pickNutrients(item)),
      );
      const mealItemChunks = chunkByParameterLimit(
        mealItems,
        itemParametersPerRow,
      );
      const now = new Date().toISOString();
      const versionNo = plan.currentVersionNo + 1;
      const isToday = scheduledDate === today;

      try {
        await db.transaction(async (tx) => {
          await tx.insert(nutritionMeals).values({
            mealId,
            localDate: scheduledDate,
            eatenAt: isToday ? now : null,
            timePrecision: isToday ? "exact" : "date_only",
            mealType: plan.mealType,
            contextTag: plan.contextTag,
            originalMealType: plan.originalMealType,
            source: "site_planned_meal",
            confidence: plan.confidence,
            currentRevisionNo: 1,
            createdBy: actor.id,
            updatedAt: now,
          });
          await tx.insert(nutritionMealRevisions).values({
            mealRevisionId,
            mealId,
            revisionNo: 1,
            revisionReason: "Confirmed planned meal",
            originalText: plan.originalText,
            notes: null,
            ...totals,
            createdBy: actor.id,
          });
          for (const rows of mealItemChunks) {
            await tx.insert(nutritionMealItems).values(rows);
          }
          const updatedPlans = await tx
            .update(nutritionMealPlans)
            .set({
              status: "consumed",
              completedMealId: mealId,
              consumedAt: now,
              currentVersionNo: versionNo,
              updatedAt: now,
            })
            .where(
              and(
                eq(nutritionMealPlans.planId, planId),
                eq(nutritionMealPlans.currentVersionNo, expectedVersionNo),
                eq(nutritionMealPlans.status, "pending"),
              ),
            )
            .returning();
          if (!updatedPlans[0]) throw new PlanWriteConflict();
          await tx.insert(auditLog).values({
            requestId: idempotencyKey,
            actor: actor.id,
            operation: "consume",
            entityType: "nutrition_plan",
            entityId: planId,
            payloadSha256: digest,
          });
          await tx.insert(auditLog).values({
            requestId: idempotencyKey,
            actor: actor.id,
            operation: "insert_from_plan",
            entityType: "nutrition_meal",
            entityId: mealId,
            payloadSha256: digest,
          });
        });
      } catch (error) {
        const concurrentReplayId = await findIdempotentReplay(
          idempotencyKey,
          "nutrition_plan",
          digest,
        );
        if (!concurrentReplayId) throw error;
        if (concurrentReplayId !== planId) {
          throw new Error("Plan consumption replay is unavailable");
        }
        return replayPlanAction({
          action: "consume",
          planId,
          expectedVersionNo,
          idempotencyKey,
          digest,
        });
      }

      return Response.json({
        planId,
        versionNo,
        mealId,
        revisionNo: 1,
        requestId: idempotencyKey,
        replay: false,
        plan: await getNutritionMealPlan(planId),
        plans: await listPendingNutritionMealPlans(),
        nutrition: await getNutritionDay(scheduledDate),
      });
    }

    if (plan.status !== "consumed" || !plan.completedMealId) {
      return apiError(
        "PLAN_CONSUMPTION_NOT_UNDOABLE",
        409,
        { status: plan.status },
        "Plan consumption cannot be undone",
      );
    }
    const mealRows = await db
      .select()
      .from(nutritionMeals)
      .where(eq(nutritionMeals.mealId, plan.completedMealId))
      .limit(1);
    const meal = mealRows[0] ?? null;
    if (!meal || meal.voidedAt) {
      return apiError(
        "PLAN_COMPLETED_MEAL_UNAVAILABLE",
        409,
        { mealId: plan.completedMealId },
        "Plan completed meal is unavailable",
      );
    }
    if (meal.currentRevisionNo !== 1 || meal.source !== "site_planned_meal") {
      return apiError(
        "PLAN_COMPLETED_MEAL_CHANGED",
        409,
        { mealId: meal.mealId, currentRevisionNo: meal.currentRevisionNo },
        "Plan completed meal has changed",
      );
    }
    const currentRevisionRows = await db
      .select()
      .from(nutritionMealRevisions)
      .where(
        and(
          eq(nutritionMealRevisions.mealId, meal.mealId),
          eq(nutritionMealRevisions.revisionNo, meal.currentRevisionNo),
        ),
      )
      .limit(1);
    const currentRevision = currentRevisionRows[0] ?? null;
    if (!currentRevision) {
      return apiError(
        "MEAL_REVISION_NOT_FOUND",
        409,
        { mealId: meal.mealId, revisionNo: meal.currentRevisionNo },
        "Meal revision not found",
      );
    }
    const now = new Date().toISOString();
    const planVersionNo = plan.currentVersionNo + 1;
    const mealRevisionNo = meal.currentRevisionNo + 1;

    try {
      await db.transaction(async (tx) => {
        const updatedPlans = await tx
          .update(nutritionMealPlans)
          .set({
            status: "pending",
            completedMealId: null,
            consumedAt: null,
            currentVersionNo: planVersionNo,
            updatedAt: now,
          })
          .where(
            and(
              eq(nutritionMealPlans.planId, planId),
              eq(nutritionMealPlans.currentVersionNo, expectedVersionNo),
              eq(nutritionMealPlans.status, "consumed"),
              eq(nutritionMealPlans.completedMealId, meal.mealId),
            ),
          )
          .returning();
        if (!updatedPlans[0]) throw new PlanWriteConflict();

        const updatedMeals = await tx
          .update(nutritionMeals)
          .set({
            currentRevisionNo: mealRevisionNo,
            voidedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(nutritionMeals.mealId, meal.mealId),
              eq(nutritionMeals.currentRevisionNo, meal.currentRevisionNo),
              eq(nutritionMeals.source, "site_planned_meal"),
              isNull(nutritionMeals.voidedAt),
            ),
          )
          .returning();
        if (!updatedMeals[0]) throw new PlanWriteConflict();

        await tx.insert(nutritionMealRevisions).values({
          mealRevisionId: `${meal.mealId}|REV|${mealRevisionNo}`,
          mealId: meal.mealId,
          revisionNo: mealRevisionNo,
          revisionReason: "Planned meal confirmation undo",
          originalText: currentRevision.originalText,
          notes: currentRevision.notes,
          ...nullNutrients(),
          createdBy: actor.id,
        });
        await tx.insert(auditLog).values({
          requestId: idempotencyKey,
          actor: actor.id,
          operation: "restore",
          entityType: "nutrition_plan",
          entityId: planId,
          payloadSha256: digest,
        });
        await tx.insert(auditLog).values({
          requestId: idempotencyKey,
          actor: actor.id,
          operation: "void_from_plan",
          entityType: "nutrition_meal",
          entityId: meal.mealId,
          payloadSha256: digest,
        });
      });
    } catch (error) {
      const concurrentReplayId = await findIdempotentReplay(
        idempotencyKey,
        "nutrition_plan",
        digest,
      );
      if (!concurrentReplayId) throw error;
      if (concurrentReplayId !== planId) {
        throw new Error("Plan undo replay is unavailable");
      }
      return replayPlanAction({
        action: "undo_consume",
        planId,
        expectedVersionNo,
        idempotencyKey,
        digest,
      });
    }

    const [storedPlan, storedMealRows] = await Promise.all([
      getNutritionMealPlan(planId),
      db
        .select()
        .from(nutritionMeals)
        .where(eq(nutritionMeals.mealId, meal.mealId))
        .limit(1),
    ]);
    const storedMeal = storedMealRows[0] ?? null;
    if (
      !storedPlan ||
      storedPlan.status !== "pending" ||
      storedPlan.versionNo !== planVersionNo ||
      storedPlan.completedMealId !== null ||
      !storedMeal ||
      storedMeal.currentRevisionNo !== mealRevisionNo ||
      !storedMeal.voidedAt
    ) {
      throw new Error("Plan undo readback mismatch");
    }

    return Response.json({
      planId,
      versionNo: planVersionNo,
      mealId: meal.mealId,
      revisionNo: mealRevisionNo,
      requestId: idempotencyKey,
      replay: false,
      plan: storedPlan,
      plans: await listPendingNutritionMealPlans(),
      nutrition: await getNutritionDay(meal.localDate),
    });
  } catch (error) {
    return planRouteError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const payload = (await request.json()) as PlanDeleteInput;
    const planId = requiredText(payload.planId, "planId");
    const expectedVersionNo = parseExpectedVersion(payload.expectedVersionNo);
    const db = getDb();
    const rows = await db
      .select()
      .from(nutritionMealPlans)
      .where(eq(nutritionMealPlans.planId, planId))
      .limit(1);
    const plan = rows[0] ?? null;
    if (!plan) {
      return apiError("PLAN_NOT_FOUND", 404, { planId }, "Plan not found");
    }

    const idempotencyKey = requestId(request);
    const digest = await payloadSha256(payload);
    const replayedId = await findIdempotentReplay(
      idempotencyKey,
      "nutrition_plan",
      digest,
    );
    if (replayedId) {
      const replayedPlan = await getNutritionMealPlan(replayedId);
      if (!replayedPlan || replayedPlan.status !== "cancelled") {
        throw new Error("Plan cancellation replay is unavailable");
      }
      return Response.json({
        planId: replayedId,
        versionNo: replayedPlan.versionNo,
        requestId: idempotencyKey,
        replay: true,
        plan: replayedPlan,
        plans: await listPendingNutritionMealPlans(),
      });
    }
    if (plan.status !== "pending") {
      return apiError(
        "PLAN_NOT_PENDING",
        409,
        { status: plan.status },
        "Plan is not pending",
      );
    }
    if (plan.currentVersionNo !== expectedVersionNo) {
      return apiError(
        "PLAN_VERSION_CONFLICT",
        409,
        { currentVersionNo: plan.currentVersionNo },
        "Plan version conflict",
      );
    }
    const now = new Date().toISOString();
    let replay = false;
    let storedVersionNo: number;
    try {
      storedVersionNo = await db.transaction(async (tx) => {
        const updated = await tx
          .update(nutritionMealPlans)
          .set({
            status: "cancelled",
            cancelledAt: now,
            currentVersionNo: plan.currentVersionNo + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(nutritionMealPlans.planId, planId),
              eq(nutritionMealPlans.currentVersionNo, expectedVersionNo),
              eq(nutritionMealPlans.status, "pending"),
            ),
          )
          .returning();
        if (!updated[0]) throw new PlanWriteConflict();
        await tx.insert(auditLog).values({
          requestId: idempotencyKey,
          actor: actor.id,
          operation: "cancel",
          entityType: "nutrition_plan",
          entityId: planId,
          payloadSha256: digest,
        });
        return updated[0].currentVersionNo;
      });
    } catch (error) {
      const concurrentReplayId = await findIdempotentReplay(
        idempotencyKey,
        "nutrition_plan",
        digest,
      );
      if (!concurrentReplayId) throw error;
      if (concurrentReplayId !== planId) {
        throw new Error("Plan cancellation replay is unavailable");
      }
      const replayedPlan = await getNutritionMealPlan(planId);
      if (!replayedPlan || replayedPlan.status !== "cancelled") {
        throw new Error("Plan cancellation replay is unavailable");
      }
      replay = true;
      storedVersionNo = replayedPlan.versionNo;
    }
    const cancelledPlan = await getNutritionMealPlan(planId);
    if (
      !cancelledPlan ||
      cancelledPlan.status !== "cancelled" ||
      cancelledPlan.versionNo !== storedVersionNo
    ) {
      throw new Error("Plan cancellation readback mismatch");
    }

    return Response.json({
      planId,
      versionNo: cancelledPlan.versionNo,
      requestId: idempotencyKey,
      replay,
      plan: cancelledPlan,
      plans: await listPendingNutritionMealPlans(),
    });
  } catch (error) {
    return planRouteError(error);
  }
}
