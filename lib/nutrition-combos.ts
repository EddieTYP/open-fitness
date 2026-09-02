import { and, asc, eq, inArray, like } from "drizzle-orm";
import { getDb } from "@/db";
import {
  nutritionComboItems,
  nutritionCombos,
  nutritionComboVersions,
  nutritionFoodVersions,
  nutritionFoods,
} from "@/db/schema";
import { chunkByParameterLimit } from "@/lib/d1-limits";
import {
  nullNutrients,
  normalizeFoodName,
  pickNutrients,
  scaleNutrients,
  sumNutrients,
  type Nutrients,
  type NutritionMealView,
} from "@/lib/nutrition";
import {
  NutritionMeasureError,
  resolveRegisteredFoodMeasure,
} from "@/lib/nutrition-measure";

export type NutritionComboMealType = NutritionMealView["mealType"];

export type NutritionComboIssue = {
  code: "inactive_food" | "missing_food" | "unit_changed";
  comboItemId: string;
  foodId: string;
  message: string;
};

export type NutritionComboItemView = {
  comboItemId: string;
  itemOrdinal: number;
  foodId: string;
  foodVersionIdAtSave: string;
  currentFoodVersionId: string | null;
  foodVersionNo: number | null;
  displayName: string;
  defaultQuantity: number;
  unit: string;
  unitAtSave: string;
  baseQuantity: number | null;
  unitCompatible: boolean;
  isActive: boolean;
  foodUpdated: boolean;
  nutrients: Nutrients;
};

export type NutritionComboView = {
  comboId: string;
  displayName: string;
  isActive: boolean;
  versionNo: number;
  comboVersionId: string;
  defaultMealType: NutritionComboMealType | null;
  contextTag: "post_workout" | null;
  items: NutritionComboItemView[];
  nutrients: Nutrients;
  isUsable: boolean;
  foodUpdated: boolean;
  issues: NutritionComboIssue[];
};

type ComboSelector =
  | { kind: "list"; query: string; includeInactive: boolean; limit: number }
  | { kind: "single"; comboId: string };

async function loadNutritionCombos(
  selector: ComboSelector,
): Promise<NutritionComboView[]> {
  const db = getDb();
  const conditions =
    selector.kind === "single"
      ? [eq(nutritionCombos.comboId, selector.comboId)]
      : [
          ...(selector.includeInactive
            ? []
            : [eq(nutritionCombos.isActive, 1)]),
          ...(normalizeFoodName(selector.query)
            ? [
                like(
                  nutritionCombos.normalizedName,
                  `%${normalizeFoodName(selector.query)}%`,
                ),
              ]
            : []),
        ];

  let comboQuery = db
    .select({
      comboId: nutritionCombos.comboId,
      displayName: nutritionCombos.displayName,
      isActive: nutritionCombos.isActive,
      versionNo: nutritionComboVersions.versionNo,
      comboVersionId: nutritionComboVersions.comboVersionId,
      defaultMealType: nutritionComboVersions.defaultMealType,
      contextTag: nutritionComboVersions.contextTag,
    })
    .from(nutritionCombos)
    .innerJoin(
      nutritionComboVersions,
      and(
        eq(nutritionComboVersions.comboId, nutritionCombos.comboId),
        eq(
          nutritionComboVersions.versionNo,
          nutritionCombos.currentVersionNo,
        ),
      ),
    )
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(nutritionCombos.displayName))
    .$dynamic();

  if (selector.kind === "list") {
    comboQuery = comboQuery.limit(
      Math.min(Math.max(selector.limit, 1), 100),
    );
  }
  const comboRows = await comboQuery;
  if (comboRows.length === 0) return [];

  const versionIds = comboRows.map((row) => row.comboVersionId);
  const itemRows: Array<{
    comboItemId: string;
    comboVersionId: string;
    itemOrdinal: number;
    foodId: string;
    foodVersionIdAtSave: string;
    defaultQuantity: number;
    unitSnapshot: string;
    displayName: string | null;
    isActive: number | null;
    currentFoodVersionId: string | null;
    foodVersionNo: number | null;
    baseQuantity: number | null;
    baseUnit: string | null;
    energyKcal: number | null;
    proteinG: number | null;
    totalFatG: number | null;
    saturatedFatG: number | null;
    transFatG: number | null;
    carbsG: number | null;
    sugarG: number | null;
    fibreG: number | null;
    sodiumMg: number | null;
    cholesterolMg: number | null;
  }> = [];
  for (const versionIdChunk of chunkByParameterLimit(versionIds)) {
    itemRows.push(
      ...(await db
        .select({
          comboItemId: nutritionComboItems.comboItemId,
          comboVersionId: nutritionComboItems.comboVersionId,
          itemOrdinal: nutritionComboItems.itemOrdinal,
          foodId: nutritionComboItems.foodId,
          foodVersionIdAtSave: nutritionComboItems.foodVersionIdAtSave,
          defaultQuantity: nutritionComboItems.defaultQuantity,
          unitSnapshot: nutritionComboItems.unitSnapshot,
          displayName: nutritionFoods.displayName,
          isActive: nutritionFoods.isActive,
          currentFoodVersionId: nutritionFoodVersions.foodVersionId,
          foodVersionNo: nutritionFoodVersions.versionNo,
          baseQuantity: nutritionFoodVersions.baseQuantity,
          baseUnit: nutritionFoodVersions.baseUnit,
          energyKcal: nutritionFoodVersions.energyKcal,
          proteinG: nutritionFoodVersions.proteinG,
          totalFatG: nutritionFoodVersions.totalFatG,
          saturatedFatG: nutritionFoodVersions.saturatedFatG,
          transFatG: nutritionFoodVersions.transFatG,
          carbsG: nutritionFoodVersions.carbsG,
          sugarG: nutritionFoodVersions.sugarG,
          fibreG: nutritionFoodVersions.fibreG,
          sodiumMg: nutritionFoodVersions.sodiumMg,
          cholesterolMg: nutritionFoodVersions.cholesterolMg,
        })
        .from(nutritionComboItems)
        .leftJoin(
          nutritionFoods,
          eq(nutritionFoods.foodId, nutritionComboItems.foodId),
        )
        .leftJoin(
          nutritionFoodVersions,
          and(
            eq(
              nutritionFoodVersions.foodId,
              nutritionFoods.foodId,
            ),
            eq(
              nutritionFoodVersions.versionNo,
              nutritionFoods.currentVersionNo,
            ),
          ),
        )
        .where(
          inArray(
            nutritionComboItems.comboVersionId,
            versionIdChunk,
          ),
        )
        .orderBy(
          asc(nutritionComboItems.comboVersionId),
          asc(nutritionComboItems.itemOrdinal),
        )),
    );
  }

  const itemsByVersion = new Map<string, NutritionComboItemView[]>();
  for (const row of itemRows) {
    let nutrientScale: number | null = null;
    if (
      row.baseQuantity !== null &&
      row.baseUnit !== null
    ) {
      try {
        nutrientScale = resolveRegisteredFoodMeasure({
          quantity: row.defaultQuantity,
          unit: row.unitSnapshot,
          baseQuantity: row.baseQuantity,
          baseUnit: row.baseUnit,
        }).nutrientScale;
      } catch (error) {
        if (!(error instanceof NutritionMeasureError)) throw error;
      }
    }
    const nutrients =
      nutrientScale === null
        ? nullNutrients()
        : scaleNutrients(pickNutrients(row), nutrientScale);
    const items = itemsByVersion.get(row.comboVersionId) ?? [];
    items.push({
      comboItemId: row.comboItemId,
      itemOrdinal: row.itemOrdinal,
      foodId: row.foodId,
      foodVersionIdAtSave: row.foodVersionIdAtSave,
      currentFoodVersionId: row.currentFoodVersionId,
      foodVersionNo: row.foodVersionNo,
      displayName: row.displayName ?? row.foodId,
      defaultQuantity: row.defaultQuantity,
      unit: row.unitSnapshot,
      unitAtSave: row.unitSnapshot,
      baseQuantity: row.baseQuantity,
      unitCompatible: nutrientScale !== null,
      isActive: row.isActive === 1,
      foodUpdated:
        row.currentFoodVersionId !== null &&
        row.foodVersionIdAtSave !== row.currentFoodVersionId,
      nutrients,
    });
    itemsByVersion.set(row.comboVersionId, items);
  }

  return comboRows.map((row) => {
    const items = itemsByVersion.get(row.comboVersionId) ?? [];
    const issues: NutritionComboIssue[] = [];
    for (const item of items) {
      if (!item.currentFoodVersionId || item.baseQuantity === null) {
        issues.push({
          code: "missing_food",
          comboItemId: item.comboItemId,
          foodId: item.foodId,
          message: `「${item.displayName}」資料唔完整，請先更新食物庫。`,
        });
        continue;
      }
      if (!item.isActive) {
        issues.push({
          code: "inactive_food",
          comboItemId: item.comboItemId,
          foodId: item.foodId,
          message: `「${item.displayName}」已停用，請先更新組合。`,
        });
      }
      if (!item.unitCompatible) {
        issues.push({
          code: "unit_changed",
          comboItemId: item.comboItemId,
          foodId: item.foodId,
          message: `「${item.displayName}」現有營養基準同已保存份量 ${item.defaultQuantity} ${item.unitAtSave} 不相容，請重新確認份量。`,
        });
      }
    }
    return {
      comboId: row.comboId,
      displayName: row.displayName,
      isActive: row.isActive === 1,
      versionNo: row.versionNo,
      comboVersionId: row.comboVersionId,
      defaultMealType:
        row.defaultMealType as NutritionComboMealType | null,
      contextTag: row.contextTag as "post_workout" | null,
      items,
      nutrients: sumNutrients(items.map((item) => item.nutrients)),
      isUsable: row.isActive === 1 && issues.length === 0 && items.length > 0,
      foodUpdated: items.some((item) => item.foodUpdated),
      issues,
    };
  });
}

export function listNutritionCombos(
  query = "",
  includeInactive = false,
  limit = 40,
) {
  return loadNutritionCombos({ kind: "list", query, includeInactive, limit });
}

export async function getNutritionCombo(comboId: string) {
  const rows = await loadNutritionCombos({ kind: "single", comboId });
  return rows[0] ?? null;
}
