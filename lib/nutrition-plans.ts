import { asc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  nutritionMealPlanItems,
  nutritionMealPlans,
} from "@/db/schema";
import { chunkByParameterLimit } from "@/lib/d1-limits";
import {
  pickNutrients,
  sumNutrients,
  type Nutrients,
  type NutritionMealView,
} from "@/lib/nutrition";

export type NutritionMealPlanItemView = {
  planItemId: string;
  name: string;
  quantity: number;
  unit: string;
  foodId: string | null;
  nutrients: Nutrients;
  assumption: string | null;
  confidence: "high" | "medium" | "low";
  dataQualityFlags: string | null;
};

export type NutritionMealPlanView = {
  planId: string;
  scheduledDate: string | null;
  mealType: NutritionMealView["mealType"];
  contextTag: string | null;
  originalMealType: string | null;
  source: string;
  confidence: "high" | "medium" | "low";
  originalText: string | null;
  status: "pending" | "consumed" | "cancelled";
  versionNo: number;
  completedMealId: string | null;
  nutrients: Nutrients;
  items: NutritionMealPlanItemView[];
};

async function hydratePlans(
  rows: Array<typeof nutritionMealPlans.$inferSelect>,
): Promise<NutritionMealPlanView[]> {
  const planIds = rows.map((row) => row.planId);
  const itemRows: Array<typeof nutritionMealPlanItems.$inferSelect> = [];
  for (const planIdChunk of chunkByParameterLimit(planIds)) {
    itemRows.push(
      ...(await getDb()
        .select()
        .from(nutritionMealPlanItems)
        .where(inArray(nutritionMealPlanItems.planId, planIdChunk))),
    );
  }
  itemRows.sort(
    (left, right) =>
      left.planId.localeCompare(right.planId) ||
      left.itemOrdinal - right.itemOrdinal,
  );

  const itemsByPlan = new Map<string, NutritionMealPlanItemView[]>();
  for (const item of itemRows) {
    const items = itemsByPlan.get(item.planId) ?? [];
    items.push({
      planItemId: item.planItemId,
      name: item.itemNameSnapshot,
      quantity: item.quantity,
      unit: item.unit,
      foodId: item.foodId,
      nutrients: pickNutrients(item),
      assumption: item.assumption,
      confidence: item.confidence as NutritionMealPlanItemView["confidence"],
      dataQualityFlags: item.dataQualityFlags,
    });
    itemsByPlan.set(item.planId, items);
  }

  return rows.map((row) => {
    const items = itemsByPlan.get(row.planId) ?? [];
    return {
      planId: row.planId,
      scheduledDate: row.scheduledDate,
      mealType: row.mealType as NutritionMealPlanView["mealType"],
      contextTag: row.contextTag,
      originalMealType: row.originalMealType,
      source: row.source,
      confidence: row.confidence as NutritionMealPlanView["confidence"],
      originalText: row.originalText,
      status: row.status as NutritionMealPlanView["status"],
      versionNo: row.currentVersionNo,
      completedMealId: row.completedMealId,
      nutrients: sumNutrients(items.map((item) => item.nutrients)),
      items,
    };
  });
}

export async function listPendingNutritionMealPlans() {
  const rows = await getDb()
    .select()
    .from(nutritionMealPlans)
    .where(eq(nutritionMealPlans.status, "pending"))
    .orderBy(
      sql`${nutritionMealPlans.scheduledDate} IS NULL`,
      asc(nutritionMealPlans.scheduledDate),
      asc(nutritionMealPlans.createdAt),
    );
  return hydratePlans(rows);
}

export async function getNutritionMealPlan(planId: string) {
  const rows = await getDb()
    .select()
    .from(nutritionMealPlans)
    .where(eq(nutritionMealPlans.planId, planId))
    .limit(1);
  const plans = await hydratePlans(rows);
  return plans[0] ?? null;
}
