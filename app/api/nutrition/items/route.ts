import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { getLocalClient } from "@/db/local-sqlite";
import {
  auditLog,
  nutritionFoodAliases,
  nutritionFoodVersions,
  nutritionFoods,
} from "@/db/schema";
import {
  getApiActor,
  routeError,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { apiError } from "@/lib/api-error";
import { findIdempotentReplay } from "@/lib/idempotency";
import {
  getNutritionFood,
  listNutritionFoods,
  normalizeFoodName,
  nutrientKeys,
  nullNutrients,
  type NutritionFood,
  type NutrientKey,
  type Nutrients,
} from "@/lib/nutrition";
import {
  finiteNumber,
  payloadSha256,
  requestId,
  requiredText,
} from "@/lib/record-utils";
import { getProfileTimezone } from "@/lib/profile-timezone";
import { dateInTimeZone } from "@/lib/timezone.mjs";

export const dynamic = "force-dynamic";

class NutritionFoodAliasConflict extends Error {
  readonly alias: string;
  readonly existingFoodId: string;

  constructor(alias: string, existingFoodId: string) {
    super("Nutrition food alias belongs to another food");
    this.alias = alias;
    this.existingFoodId = existingFoodId;
  }
}

class NutritionFoodVersionConflict extends Error {
  readonly foodId: string;

  constructor(foodId: string) {
    super("Nutrition food changed during revision");
    this.foodId = foodId;
  }
}

class NutritionFoodReplayStale extends Error {
  readonly foodId: string;
  readonly versionNo: number;

  constructor(foodId: string, versionNo: number) {
    super("Nutrition food replay revision is no longer current");
    this.foodId = foodId;
    this.versionNo = versionNo;
  }
}

class NutritionFoodToggleReplayConflict extends Error {
  readonly foodId: string;

  constructor(foodId: string) {
    super("Nutrition food toggle replay is no longer reconstructable");
    this.foodId = foodId;
  }
}

class NutritionFoodToggleConflict extends Error {
  readonly foodId: string;

  constructor(foodId: string) {
    super("Nutrition food changed during toggle");
    this.foodId = foodId;
  }
}

function foodRouteError(error: unknown) {
  if (error instanceof NutritionFoodAliasConflict) {
    return apiError(
      "NUTRITION_FOOD_ALIAS_CONFLICT",
      409,
      { alias: error.alias, foodId: error.existingFoodId },
      "Nutrition food alias belongs to another food",
    );
  }
  if (error instanceof NutritionFoodVersionConflict) {
    return apiError(
      "NUTRITION_FOOD_VERSION_CONFLICT",
      409,
      { foodId: error.foodId },
      "Nutrition food changed during revision",
    );
  }
  if (error instanceof NutritionFoodReplayStale) {
    return apiError(
      "NUTRITION_FOOD_REPLAY_STALE",
      409,
      { foodId: error.foodId, versionNo: error.versionNo },
      "Nutrition food replay revision is no longer current",
    );
  }
  if (error instanceof NutritionFoodToggleReplayConflict) {
    return apiError(
      "NUTRITION_FOOD_TOGGLE_REPLAY_CONFLICT",
      409,
      { foodId: error.foodId },
      "Nutrition food toggle replay is no longer reconstructable",
    );
  }
  if (error instanceof NutritionFoodToggleConflict) {
    return apiError(
      "NUTRITION_FOOD_TOGGLE_CONFLICT",
      409,
      { foodId: error.foodId },
      "Nutrition food changed during toggle",
    );
  }
  return routeError(error);
}

type FoodInput = {
  foodId?: string;
  displayName?: string;
  brand?: string | null;
  category?: string | null;
  baseQuantity?: number;
  baseUnit?: string;
  alias?: string | null;
  sourceNote?: string | null;
  nutrients?: Partial<Record<NutrientKey, number | null>>;
};

type FoodPatch = FoodInput & {
  action?: "revise" | "deactivate" | "reactivate";
};

function parseNutrients(
  values: FoodInput["nutrients"],
  fallback?: Nutrients,
): Nutrients {
  const result = fallback ? { ...fallback } : nullNutrients();
  for (const key of nutrientKeys) {
    if (!values || !(key in values)) continue;
    result[key] = finiteNumber(values[key], {
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

type FoodIdentitySnapshot = Pick<
  typeof nutritionFoods.$inferSelect,
  | "foodId"
  | "displayName"
  | "brand"
  | "category"
  | "defaultUnit"
  | "isActive"
  | "source"
  | "originalLabel"
>;

function foodRevisionEntityId(foodId: string, versionNo: number) {
  return `${foodId}|REVISION|${versionNo}`;
}

function foodRevisionNoFromEntityId(foodId: string, entityId: string) {
  const prefix = `${foodId}|REVISION|`;
  if (!entityId.startsWith(prefix)) return null;
  const versionNo = Number(entityId.slice(prefix.length));
  return Number.isSafeInteger(versionNo) && versionNo > 0 ? versionNo : null;
}

type FoodToggleReceipt = {
  versionNo: number;
  isActive: boolean;
};

function foodToggleEntityId(
  foodId: string,
  versionNo: number,
  isActive: boolean,
) {
  return `${foodId}|TOGGLE|${versionNo}|${isActive ? "ACTIVE" : "INACTIVE"}`;
}

function foodToggleReceiptFromEntityId(
  foodId: string,
  entityId: string,
): FoodToggleReceipt | null {
  const prefix = `${foodId}|TOGGLE|`;
  if (!entityId.startsWith(prefix)) return null;
  const [versionText, state, ...extra] = entityId.slice(prefix.length).split("|");
  const versionNo = Number(versionText);
  if (
    extra.length > 0 ||
    !Number.isSafeInteger(versionNo) ||
    versionNo <= 0 ||
    (state !== "ACTIVE" && state !== "INACTIVE")
  ) {
    return null;
  }
  return { versionNo, isActive: state === "ACTIVE" };
}

function nextFoodUpdatedAt(currentUpdatedAt: string) {
  const currentTimestamp = Date.parse(currentUpdatedAt);
  const nextTimestamp = Math.max(
    Date.now(),
    Number.isFinite(currentTimestamp) ? currentTimestamp + 1 : 0,
  );
  return new Date(nextTimestamp).toISOString();
}

async function hydrateNutritionFoodRevision(
  food: FoodIdentitySnapshot,
  versionNo: number,
): Promise<NutritionFood | null> {
  const db = getDb();
  const versionRows = await db
    .select()
    .from(nutritionFoodVersions)
    .where(
      and(
        eq(nutritionFoodVersions.foodId, food.foodId),
        eq(nutritionFoodVersions.versionNo, versionNo),
      ),
    )
    .limit(1);
  const version = versionRows[0] ?? null;
  if (!version) return null;
  const aliasRows = await db
    .select({ alias: nutritionFoodAliases.alias })
    .from(nutritionFoodAliases)
    .where(eq(nutritionFoodAliases.foodId, food.foodId))
    .orderBy(
      asc(nutritionFoodAliases.createdAt),
      asc(nutritionFoodAliases.aliasId),
    );
  return {
    foodId: food.foodId,
    foodVersionId: version.foodVersionId,
    displayName: food.displayName,
    brand: food.brand,
    category: food.category,
    defaultUnit: food.defaultUnit,
    isActive: food.isActive === 1,
    source: food.source,
    originalLabel: food.originalLabel,
    aliases: aliasRows.map((row) => row.alias),
    versionNo: version.versionNo,
    baseQuantity: version.baseQuantity,
    baseUnit: version.baseUnit,
    sourceNote: version.sourceNote,
    effectiveFrom: version.effectiveFrom,
    nutrients: Object.fromEntries(
      nutrientKeys.map((key) => [key, version[key]]),
    ) as Nutrients,
  };
}

export async function GET(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const url = new URL(request.url);
    const query = url.searchParams.get("q") || "";
    const includeInactive = url.searchParams.get("includeInactive") === "true";
    const items = await listNutritionFoods(query, includeInactive, 80);
    return Response.json(
      { items },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return foodRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const today = dateInTimeZone(new Date(), await getProfileTimezone());
    const payload = (await request.json()) as FoodInput;
    const displayName = requiredText(payload.displayName, "displayName");
    const brand = payload.brand?.trim() || null;
    const originalLabel = payload.alias?.trim() || displayName;
    const normalizedName = normalizeFoodName(displayName);
    const baseUnit = requiredText(payload.baseUnit, "baseUnit");
    const baseQuantity = finiteNumber(payload.baseQuantity ?? 1, {
      min: 0.001,
      max: 100000,
    })!;
    const nutrients = parseNutrients(payload.nutrients);
    const idempotencyKey = requestId(request);
    const digest = await payloadSha256(payload);
    const replayedId = await findIdempotentReplay(
      idempotencyKey,
      "nutrition_food",
      digest,
    );
    if (replayedId) {
      const replayedItem = await getNutritionFood(replayedId);
      if (!replayedItem) {
        throw new Error("Nutrition food replay is unavailable");
      }
      return Response.json({
        foodId: replayedId,
        requestId: idempotencyKey,
        replay: true,
        item: replayedItem,
      });
    }

    const db = getDb();
    const duplicate = await db
      .select({ foodId: nutritionFoods.foodId })
      .from(nutritionFoods)
      .where(eq(nutritionFoods.normalizedName, normalizedName))
      .limit(1);
    if (duplicate[0]) {
      const concurrentReplayId = await findIdempotentReplay(
        idempotencyKey,
        "nutrition_food",
        digest,
      );
      if (concurrentReplayId) {
        const replayedItem = await getNutritionFood(concurrentReplayId);
        if (!replayedItem) {
          throw new Error("Nutrition food replay is unavailable");
        }
        return Response.json({
          foodId: concurrentReplayId,
          requestId: idempotencyKey,
          replay: true,
          item: replayedItem,
        });
      }
      return apiError(
        "NUTRITION_FOOD_ALREADY_EXISTS",
        409,
        { foodId: duplicate[0].foodId },
        "Nutrition food already exists",
      );
    }

    const foodId = payload.foodId?.trim() || `FOOD|${crypto.randomUUID()}`;
    const versionId = `${foodId}|V1`;
    const aliasId = `${foodId}|ALIAS|1`;
    let writeResult: { foodId: string; replay: boolean };
    try {
      const batchResults = await getLocalClient().batch(
        [
          {
            sql: `INSERT INTO nutrition_foods (
                    food_id, display_name, normalized_name, brand, category,
                    default_unit, is_active, source, original_label,
                    current_version_no, updated_at
                  )
                  SELECT ?, ?, ?, ?, ?, ?, 1, ?, ?, 1, ?
                   WHERE NOT EXISTS (
                     SELECT 1 FROM audit_log
                      WHERE request_id = ? AND entity_type = 'nutrition_food'
                   )`,
            args: [
              foodId,
              displayName,
              normalizedName,
              brand,
              payload.category?.trim() || null,
              baseUnit,
              actor.kind === "fitness-agent"
                ? "Agent item creation"
                : "Site item management",
              originalLabel,
              new Date().toISOString(),
              idempotencyKey,
            ],
          },
          {
            sql: `INSERT INTO nutrition_food_versions (
                    food_version_id, food_id, version_no, base_quantity,
                    base_unit, energy_kcal, protein_g, total_fat_g,
                    saturated_fat_g, trans_fat_g, carbs_g, sugar_g, fibre_g,
                    sodium_mg, cholesterol_mg, source_note, effective_from
                  )
                  SELECT ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                   WHERE NOT EXISTS (
                     SELECT 1 FROM audit_log
                      WHERE request_id = ? AND entity_type = 'nutrition_food'
                   )`,
            args: [
              versionId,
              foodId,
              baseQuantity,
              baseUnit,
              nutrients.energyKcal,
              nutrients.proteinG,
              nutrients.totalFatG,
              nutrients.saturatedFatG,
              nutrients.transFatG,
              nutrients.carbsG,
              nutrients.sugarG,
              nutrients.fibreG,
              nutrients.sodiumMg,
              nutrients.cholesterolMg,
              payload.sourceNote?.trim() || null,
              today,
              idempotencyKey,
            ],
          },
          {
            sql: `INSERT INTO nutrition_food_aliases (
                    alias_id, food_id, alias, normalized_alias, source
                  )
                  SELECT ?, ?, ?, ?, 'Food item creation'
                   WHERE NOT EXISTS (
                     SELECT 1 FROM audit_log
                      WHERE request_id = ? AND entity_type = 'nutrition_food'
                   )`,
            args: [
              aliasId,
              foodId,
              originalLabel,
              normalizeFoodName(originalLabel),
              idempotencyKey,
            ],
          },
          {
            sql: `INSERT INTO audit_log (
                    request_id, actor, operation, entity_type, entity_id,
                    payload_sha256
                  )
                  SELECT ?, ?, 'insert', 'nutrition_food', ?, ?
                   WHERE NOT EXISTS (
                     SELECT 1 FROM audit_log
                      WHERE request_id = ? AND entity_type = 'nutrition_food'
                   )`,
            args: [
              idempotencyKey,
              actor.id,
              foodId,
              digest,
              idempotencyKey,
            ],
          },
        ],
        "write",
      );
      const committedFoodId = await findIdempotentReplay(
        idempotencyKey,
        "nutrition_food",
        digest,
      );
      if (!committedFoodId) {
        throw new Error("Nutrition food idempotency receipt is unavailable");
      }
      writeResult = {
        foodId: committedFoodId,
        replay: batchResults[3].rowsAffected === 0,
      };
    } catch (error) {
      const concurrentReplayId = await findIdempotentReplay(
        idempotencyKey,
        "nutrition_food",
        digest,
      );
      if (!concurrentReplayId) throw error;
      writeResult = {
        foodId: concurrentReplayId,
        replay: true,
      };
    }

    if (writeResult.replay) {
      const replayedItem = await getNutritionFood(writeResult.foodId);
      if (!replayedItem) {
        throw new Error("Nutrition food replay is unavailable");
      }
      return Response.json({
        foodId: writeResult.foodId,
        requestId: idempotencyKey,
        replay: true,
        item: replayedItem,
      });
    }

    return Response.json(
      {
        foodId,
        requestId: idempotencyKey,
        replay: false,
        item: await getNutritionFood(foodId),
      },
      { status: 201 },
    );
  } catch (error) {
    return foodRouteError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const today = dateInTimeZone(new Date(), await getProfileTimezone());
    const payload = (await request.json()) as FoodPatch;
    const foodId = requiredText(payload.foodId, "foodId");
    const action = payload.action ?? "revise";
    const db = getDb();
    const existing = await getNutritionFood(foodId);
    if (!existing) {
      return apiError(
        "NUTRITION_FOOD_NOT_FOUND",
        404,
        { foodId },
        "Nutrition food not found",
      );
    }

    const idempotencyKey = requestId(request);
    const digest = await payloadSha256(payload);
    const replayedId = await findIdempotentReplay(
      idempotencyKey,
      "nutrition_food",
      digest,
    );
    if (replayedId) {
      const replayedVersionNo =
        action === "revise"
          ? foodRevisionNoFromEntityId(foodId, replayedId)
          : null;
      const replayedToggle =
        action === "deactivate" || action === "reactivate"
          ? foodToggleReceiptFromEntityId(foodId, replayedId)
          : null;
      if (
        action !== "deactivate" &&
        action !== "reactivate" &&
        replayedId !== foodId &&
        replayedVersionNo === null
      ) {
        throw new Error("Nutrition food replay is unavailable");
      }
      const replayedItem = await getNutritionFood(foodId);
      if (!replayedItem) {
        throw new Error("Nutrition food replay is unavailable");
      }
      if (
        replayedVersionNo !== null &&
        replayedItem.versionNo !== replayedVersionNo
      ) {
        throw new NutritionFoodReplayStale(foodId, replayedVersionNo);
      }
      if (
        (action === "deactivate" || action === "reactivate") &&
        (!replayedToggle || replayedItem.versionNo !== replayedToggle.versionNo)
      ) {
        throw new NutritionFoodToggleReplayConflict(foodId);
      }
      const replayedReceipt = replayedToggle
        ? { ...replayedItem, isActive: replayedToggle.isActive }
        : replayedItem;
      return Response.json({
        foodId,
        versionNo: replayedReceipt.versionNo,
        requestId: idempotencyKey,
        replay: true,
        item: replayedReceipt,
      });
    }

    if (action === "deactivate" || action === "reactivate") {
      const isActive = action === "reactivate";
      const foodRows = await db
        .select()
        .from(nutritionFoods)
        .where(eq(nutritionFoods.foodId, foodId))
        .limit(1);
      const food = foodRows[0] ?? null;
      if (!food) {
        throw new Error("Nutrition food readback mismatch");
      }

      let replay = false;
      let storedFood: typeof nutritionFoods.$inferSelect | null = null;
      try {
        storedFood = await db.transaction(async (tx) => {
          const updatedFoods = await tx
            .update(nutritionFoods)
            .set({
              isActive: isActive ? 1 : 0,
              updatedAt: nextFoodUpdatedAt(food.updatedAt),
            })
            .where(
              and(
                eq(nutritionFoods.foodId, foodId),
                eq(
                  nutritionFoods.currentVersionNo,
                  food.currentVersionNo,
                ),
                eq(nutritionFoods.isActive, food.isActive),
                eq(nutritionFoods.updatedAt, food.updatedAt),
              ),
            )
            .returning();
          const updatedFood = updatedFoods[0] ?? null;
          if (!updatedFood) {
            throw new NutritionFoodToggleConflict(foodId);
          }
          await tx.insert(auditLog).values({
            requestId: idempotencyKey,
            actor: actor.id,
            operation: action,
            entityType: "nutrition_food",
            entityId: foodToggleEntityId(
              foodId,
              updatedFood.currentVersionNo,
              updatedFood.isActive === 1,
            ),
            payloadSha256: digest,
          });
          return updatedFood;
        });
      } catch (error) {
        const concurrentReplayId = await findIdempotentReplay(
          idempotencyKey,
          "nutrition_food",
          digest,
        );
        if (!concurrentReplayId) throw error;
        const concurrentReplay = foodToggleReceiptFromEntityId(
          foodId,
          concurrentReplayId,
        );
        const replayedItem = await getNutritionFood(foodId);
        if (
          !concurrentReplay ||
          !replayedItem ||
          replayedItem.versionNo !== concurrentReplay.versionNo
        ) {
          throw new NutritionFoodToggleReplayConflict(foodId);
        }
        replay = true;
        storedFood = {
          ...food,
          currentVersionNo: concurrentReplay.versionNo,
          isActive: concurrentReplay.isActive ? 1 : 0,
        };
      }

      const item = storedFood
        ? await hydrateNutritionFoodRevision(
            storedFood,
            storedFood.currentVersionNo,
          )
        : null;
      if (!item) throw new Error("Nutrition food readback mismatch");
      return Response.json({
        foodId,
        versionNo: item.versionNo,
        requestId: idempotencyKey,
        replay,
        item,
      });
    }

    if (action !== "revise") {
      return apiError(
        "INVALID_NUTRITION_FOOD_ACTION",
        400,
        { action, allowedActions: ["revise", "deactivate", "reactivate"] },
        "Invalid nutrition food action",
      );
    }

    const foodRows = await db
      .select()
      .from(nutritionFoods)
      .where(eq(nutritionFoods.foodId, foodId))
      .limit(1);
    const food = foodRows[0]!;
    const currentVersionRows = await db
      .select()
      .from(nutritionFoodVersions)
      .where(
        and(
          eq(nutritionFoodVersions.foodId, foodId),
          eq(nutritionFoodVersions.versionNo, food.currentVersionNo),
        ),
      )
      .limit(1);
    const currentVersion = currentVersionRows[0]!;
    const versionNo = food.currentVersionNo + 1;
    const displayName = payload.displayName?.trim() || food.displayName;
    const brand =
      payload.brand === undefined ? food.brand : payload.brand?.trim() || null;
    const category =
      payload.category === undefined
        ? food.category
        : payload.category?.trim() || null;
    const baseUnit = payload.baseUnit?.trim() || currentVersion.baseUnit;
    const baseQuantity =
      payload.baseQuantity === undefined
        ? currentVersion.baseQuantity
        : finiteNumber(payload.baseQuantity, {
            min: 0.001,
            max: 100000,
          })!;
    const nutrients = parseNutrients(
      payload.nutrients,
      Object.fromEntries(
        nutrientKeys.map((key) => [key, currentVersion[key]]),
      ) as Nutrients,
    );
    const additionalAlias = payload.alias?.trim() || null;
    const normalizedAlias = additionalAlias
      ? normalizeFoodName(additionalAlias)
      : null;

    let replay = false;
    let storedFood: FoodIdentitySnapshot | null = null;
    try {
      storedFood = await db.transaction(async (tx) => {
        const updatedFoods = await tx
          .update(nutritionFoods)
          .set({
            displayName,
            normalizedName: normalizeFoodName(displayName),
            brand,
            category,
            defaultUnit: baseUnit,
            currentVersionNo: versionNo,
            updatedAt: new Date().toISOString(),
          })
          .where(
            and(
              eq(nutritionFoods.foodId, foodId),
              eq(nutritionFoods.currentVersionNo, food.currentVersionNo),
            ),
          )
          .returning();
        if (!updatedFoods[0]) {
          throw new NutritionFoodVersionConflict(foodId);
        }
        await tx.insert(nutritionFoodVersions).values({
          foodVersionId: `${foodId}|V${versionNo}`,
          foodId,
          versionNo,
          baseQuantity,
          baseUnit,
          ...nutrients,
          sourceNote: payload.sourceNote?.trim() || "Revised nutrition data",
          effectiveFrom: today,
        });
        if (additionalAlias && normalizedAlias) {
          await tx
            .insert(nutritionFoodAliases)
            .values({
              aliasId: `${foodId}|ALIAS|${crypto.randomUUID()}`,
              foodId,
              alias: additionalAlias,
              normalizedAlias,
              source: "Food item revision",
            })
            .onConflictDoNothing();
          const aliasRows = await tx
            .select({ foodId: nutritionFoodAliases.foodId })
            .from(nutritionFoodAliases)
            .where(eq(nutritionFoodAliases.normalizedAlias, normalizedAlias))
            .limit(1);
          const storedAlias = aliasRows[0] ?? null;
          if (!storedAlias) {
            throw new Error("Nutrition food alias readback mismatch");
          }
          if (storedAlias.foodId !== foodId) {
            throw new NutritionFoodAliasConflict(
              additionalAlias,
              storedAlias.foodId,
            );
          }
        }
        await tx.insert(auditLog).values({
          requestId: idempotencyKey,
          actor: actor.id,
          operation: "revise",
          entityType: "nutrition_food",
          entityId: foodRevisionEntityId(foodId, versionNo),
          payloadSha256: digest,
        });
        return updatedFoods[0];
      });
    } catch (error) {
      const concurrentReplayId = await findIdempotentReplay(
        idempotencyKey,
        "nutrition_food",
        digest,
      );
      if (!concurrentReplayId) throw error;
      if (
        foodRevisionNoFromEntityId(foodId, concurrentReplayId) !== versionNo
      ) {
        throw new Error("Nutrition food replay is unavailable");
      }
      replay = true;
      storedFood = {
        foodId,
        displayName,
        brand,
        category,
        defaultUnit: baseUnit,
        isActive: food.isActive,
        source: food.source,
        originalLabel: food.originalLabel,
      };
    }

    const item = storedFood
      ? await hydrateNutritionFoodRevision(storedFood, versionNo)
      : null;
    if (
      !item ||
      (normalizedAlias &&
        !item.aliases.some(
          (alias) => normalizeFoodName(alias) === normalizedAlias,
        ))
    ) {
      throw new Error("Nutrition food readback mismatch");
    }

    return Response.json({
      foodId,
      versionNo: item.versionNo,
      requestId: idempotencyKey,
      replay,
      item,
    });
  } catch (error) {
    return foodRouteError(error);
  }
}
