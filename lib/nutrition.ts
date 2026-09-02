import {
  and,
  asc,
  between,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  lte,
  ne,
  or,
} from "drizzle-orm";
import { getDb } from "@/db";
import {
  bodyMeasurements,
  nutritionEnergyObservations,
  nutritionFoodAliases,
  nutritionFoodVersions,
  nutritionFoods,
  nutritionMealItems,
  nutritionMealRevisions,
  nutritionMeals,
  nutritionSettings,
} from "@/db/schema";
import { chunkByParameterLimit } from "@/lib/d1-limits";
import {
  deriveNutritionDayState,
  deriveNutritionFigures,
  preferredEnergyObservation,
  type NutritionActivityState,
} from "@/lib/nutrition-state";
import { getProfileTimezone } from "@/lib/profile-timezone";
import { dateInTimeZone, DEFAULT_TIMEZONE } from "@/lib/timezone.mjs";

export const nutrientKeys = [
  "energyKcal",
  "proteinG",
  "totalFatG",
  "saturatedFatG",
  "transFatG",
  "carbsG",
  "sugarG",
  "fibreG",
  "sodiumMg",
  "cholesterolMg",
] as const;

export type NutrientKey = (typeof nutrientKeys)[number];

export type Nutrients = Record<NutrientKey, number | null>;

export type NutritionFood = {
  foodId: string;
  foodVersionId: string;
  displayName: string;
  brand: string | null;
  category: string | null;
  defaultUnit: string;
  isActive: boolean;
  source: string;
  originalLabel: string | null;
  aliases: string[];
  versionNo: number;
  baseQuantity: number;
  baseUnit: string;
  sourceNote: string | null;
  effectiveFrom: string;
  nutrients: Nutrients;
};

export type NutritionMealItemView = {
  mealItemId: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  foodId: string | null;
  nutrients: Nutrients;
  assumption: string | null;
  confidence: "high" | "medium" | "low";
  dataQualityFlags: string | null;
};

export type NutritionMealView = {
  mealId: string;
  localDate: string;
  eatenAt: string | null;
  timePrecision: "exact" | "inferred" | "date_only";
  mealType:
    | "breakfast"
    | "lunch"
    | "dinner"
    | "snack"
    | "late_night"
    | "other";
  contextTag: string | null;
  originalMealType: string | null;
  source: string;
  confidence: "high" | "medium" | "low";
  revisionNo: number;
  originalText: string | null;
  notes: string | null;
  nutrients: Nutrients;
  items: NutritionMealItemView[];
};

export type NutritionTrendDay = {
  localDate: string;
  energyKcal: number | null;
  energyTargetKcal: number | null;
  proteinG: number | null;
  proteinTargetG: number | null;
  activityState: "missing" | "provisional" | "final";
};

export type NutritionDayData = {
  status: "ready" | "empty" | "unavailable";
  localDate: string;
  intakeState: "no_record" | "recording" | "closed";
  activityState: "missing" | "provisional" | "final";
  settlementState: "unavailable" | "provisional" | "final";
  ruleState: "provisional" | "active" | null;
  budget: {
    bmrKcal: number | null;
    targetKcal: number | null;
    consumedKcal: number | null;
    remainingKcal: number | null;
    targetVarianceKcal: number | null;
    estimatedExpenditureKcal: number | null;
    estimatedBalanceKcal: number | null;
    isComplete: boolean;
    isProvisional: boolean;
    basis: "fixed_daily_target" | "bmr_deficit_plus_active_energy" | null;
  };
  protein: {
    consumedG: number | null;
    targetG: number | null;
  };
  activeEnergy: {
    kcal: number | null;
    observedAt: string | null;
    status: "provisional" | "final" | null;
    source: string | null;
  };
  nutrients: Nutrients;
  meals: NutritionMealView[];
  sevenDay: {
    loggedDays: number;
    averageEnergyKcal: number | null;
    averageProteinG: number | null;
  };
  trend: {
    days: NutritionTrendDay[];
  };
  message: "NO_MEALS_RECORDED" | "NUTRITION_DATA_UNAVAILABLE" | null;
};

function round(value: number, digits = 3) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

export function nullNutrients(): Nutrients {
  return {
    energyKcal: null,
    proteinG: null,
    totalFatG: null,
    saturatedFatG: null,
    transFatG: null,
    carbsG: null,
    sugarG: null,
    fibreG: null,
    sodiumMg: null,
    cholesterolMg: null,
  };
}

export function pickNutrients(
  row: Partial<Record<NutrientKey, number | null>>,
): Nutrients {
  return Object.fromEntries(
    nutrientKeys.map((key) => [key, row[key] ?? null]),
  ) as Nutrients;
}

export function scaleNutrients(
  nutrients: Nutrients,
  multiplier: number,
): Nutrients {
  return Object.fromEntries(
    nutrientKeys.map((key) => [
      key,
      nutrients[key] === null
        ? null
        : round(nutrients[key] * multiplier),
    ]),
  ) as Nutrients;
}

export function sumNutrients(
  values: Nutrients[],
  strict = true,
): Nutrients {
  if (values.length === 0) return nullNutrients();

  return Object.fromEntries(
    nutrientKeys.map((key) => {
      const known = values
        .map((value) => value[key])
        .filter((value): value is number => value !== null);
      if (known.length === 0 || (strict && known.length !== values.length)) {
        return [key, null];
      }
      return [key, round(known.reduce((total, value) => total + value, 0))];
    }),
  ) as Nutrients;
}

export function normalizeFoodName(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("zh-HK")
    .replace(/[\s\u3000]+/g, " ");
}

export function inferMealType(
  timestamp = new Date(),
  timezone = DEFAULT_TIMEZONE,
) {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(timestamp),
  );
  if (hour >= 5 && hour < 11) return "breakfast" as const;
  if (hour >= 11 && hour < 16) return "lunch" as const;
  if (hour >= 17 && hour < 22) return "dinner" as const;
  if (hour >= 22 || hour < 5) return "late_night" as const;
  return "snack" as const;
}

function startDateForWindow(localDate: string, days: number) {
  const date = new Date(`${localDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (days - 1));
  return date.toISOString().slice(0, 10);
}

function dateWindow(localDate: string, days: number) {
  const startDate = startDateForWindow(localDate, days);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(`${startDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}

export async function listNutritionFoods(
  query = "",
  includeInactive = false,
  limit = 40,
): Promise<NutritionFood[]> {
  const db = getDb();
  const normalizedQuery = normalizeFoodName(query);
  const searchPattern = `%${normalizedQuery}%`;
  const conditions = [
    ...(includeInactive ? [] : [eq(nutritionFoods.isActive, 1)]),
    ...(normalizedQuery
      ? [
          or(
            like(nutritionFoods.normalizedName, searchPattern),
            like(nutritionFoodAliases.normalizedAlias, searchPattern),
          )!,
        ]
      : []),
  ];

  const rows = await db
    .select({
      foodId: nutritionFoods.foodId,
      displayName: nutritionFoods.displayName,
      brand: nutritionFoods.brand,
      category: nutritionFoods.category,
      defaultUnit: nutritionFoods.defaultUnit,
      isActive: nutritionFoods.isActive,
      source: nutritionFoods.source,
      originalLabel: nutritionFoods.originalLabel,
      versionNo: nutritionFoodVersions.versionNo,
      foodVersionId: nutritionFoodVersions.foodVersionId,
      baseQuantity: nutritionFoodVersions.baseQuantity,
      baseUnit: nutritionFoodVersions.baseUnit,
      sourceNote: nutritionFoodVersions.sourceNote,
      effectiveFrom: nutritionFoodVersions.effectiveFrom,
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
    .from(nutritionFoods)
    .innerJoin(
      nutritionFoodVersions,
      and(
        eq(nutritionFoodVersions.foodId, nutritionFoods.foodId),
        eq(
          nutritionFoodVersions.versionNo,
          nutritionFoods.currentVersionNo,
        ),
      ),
    )
    .leftJoin(
      nutritionFoodAliases,
      eq(nutritionFoodAliases.foodId, nutritionFoods.foodId),
    )
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(
      nutritionFoods.foodId,
      nutritionFoodVersions.foodVersionId,
    )
    .orderBy(asc(nutritionFoods.displayName))
    .limit(Math.min(Math.max(limit, 1), 100));

  const aliases = await nutritionAliasesByFoodId(
    rows.map((row) => row.foodId),
  );
  return rows.map((row) => ({
    foodId: row.foodId,
    foodVersionId: row.foodVersionId,
    displayName: row.displayName,
    brand: row.brand,
    category: row.category,
    defaultUnit: row.defaultUnit,
    isActive: row.isActive === 1,
    source: row.source,
    originalLabel: row.originalLabel,
    aliases: aliases.get(row.foodId) ?? [],
    versionNo: row.versionNo,
    baseQuantity: row.baseQuantity,
    baseUnit: row.baseUnit,
    sourceNote: row.sourceNote,
    effectiveFrom: row.effectiveFrom,
    nutrients: pickNutrients(row),
  }));
}

async function nutritionAliasesByFoodId(foodIds: string[]) {
  const aliases = new Map<string, string[]>();
  for (const foodIdChunk of chunkByParameterLimit(foodIds)) {
    const rows = await getDb()
      .select({
        foodId: nutritionFoodAliases.foodId,
        alias: nutritionFoodAliases.alias,
      })
      .from(nutritionFoodAliases)
      .where(inArray(nutritionFoodAliases.foodId, foodIdChunk))
      .orderBy(
        asc(nutritionFoodAliases.foodId),
        asc(nutritionFoodAliases.createdAt),
        asc(nutritionFoodAliases.aliasId),
      );
    for (const row of rows) {
      const values = aliases.get(row.foodId) ?? [];
      values.push(row.alias);
      aliases.set(row.foodId, values);
    }
  }
  return aliases;
}

export async function getNutritionFood(
  foodId: string,
): Promise<NutritionFood | null> {
  const rows = await getDb()
    .select({
      foodId: nutritionFoods.foodId,
      displayName: nutritionFoods.displayName,
      brand: nutritionFoods.brand,
      category: nutritionFoods.category,
      defaultUnit: nutritionFoods.defaultUnit,
      isActive: nutritionFoods.isActive,
      source: nutritionFoods.source,
      originalLabel: nutritionFoods.originalLabel,
      versionNo: nutritionFoodVersions.versionNo,
      foodVersionId: nutritionFoodVersions.foodVersionId,
      baseQuantity: nutritionFoodVersions.baseQuantity,
      baseUnit: nutritionFoodVersions.baseUnit,
      sourceNote: nutritionFoodVersions.sourceNote,
      effectiveFrom: nutritionFoodVersions.effectiveFrom,
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
    .from(nutritionFoods)
    .innerJoin(
      nutritionFoodVersions,
      and(
        eq(nutritionFoodVersions.foodId, nutritionFoods.foodId),
        eq(
          nutritionFoodVersions.versionNo,
          nutritionFoods.currentVersionNo,
        ),
      ),
    )
    .where(eq(nutritionFoods.foodId, foodId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const aliases = await nutritionAliasesByFoodId([row.foodId]);
  return {
    foodId: row.foodId,
    foodVersionId: row.foodVersionId,
    displayName: row.displayName,
    brand: row.brand,
    category: row.category,
    defaultUnit: row.defaultUnit,
    isActive: row.isActive === 1,
    source: row.source,
    originalLabel: row.originalLabel,
    aliases: aliases.get(row.foodId) ?? [],
    versionNo: row.versionNo,
    baseQuantity: row.baseQuantity,
    baseUnit: row.baseUnit,
    sourceNote: row.sourceNote,
    effectiveFrom: row.effectiveFrom,
    nutrients: pickNutrients(row),
  };
}

export async function getNutritionDay(
  requestedDate?: string,
): Promise<NutritionDayData> {
  const localDate =
    requestedDate ?? dateInTimeZone(new Date(), await getProfileTimezone());
  try {
    const db = getDb();
    const mealRows = await db
      .select({
        mealId: nutritionMeals.mealId,
        localDate: nutritionMeals.localDate,
        eatenAt: nutritionMeals.eatenAt,
        timePrecision: nutritionMeals.timePrecision,
        mealType: nutritionMeals.mealType,
        contextTag: nutritionMeals.contextTag,
        originalMealType: nutritionMeals.originalMealType,
        source: nutritionMeals.source,
        confidence: nutritionMeals.confidence,
        revisionNo: nutritionMealRevisions.revisionNo,
        mealRevisionId: nutritionMealRevisions.mealRevisionId,
        originalText: nutritionMealRevisions.originalText,
        notes: nutritionMealRevisions.notes,
        energyKcal: nutritionMealRevisions.energyKcal,
        proteinG: nutritionMealRevisions.proteinG,
        totalFatG: nutritionMealRevisions.totalFatG,
        saturatedFatG: nutritionMealRevisions.saturatedFatG,
        transFatG: nutritionMealRevisions.transFatG,
        carbsG: nutritionMealRevisions.carbsG,
        sugarG: nutritionMealRevisions.sugarG,
        fibreG: nutritionMealRevisions.fibreG,
        sodiumMg: nutritionMealRevisions.sodiumMg,
        cholesterolMg: nutritionMealRevisions.cholesterolMg,
      })
      .from(nutritionMeals)
      .innerJoin(
        nutritionMealRevisions,
        and(
          eq(nutritionMealRevisions.mealId, nutritionMeals.mealId),
          eq(
            nutritionMealRevisions.revisionNo,
            nutritionMeals.currentRevisionNo,
          ),
        ),
      )
      .where(
        and(
          eq(nutritionMeals.localDate, localDate),
          isNull(nutritionMeals.voidedAt),
        ),
      )
      .orderBy(
        asc(nutritionMeals.eatenAt),
        asc(nutritionMeals.createdAt),
      );

    const revisionIds = mealRows.map((row) => row.mealRevisionId);
    const itemRows: Array<typeof nutritionMealItems.$inferSelect> = [];
    for (const revisionIdChunk of chunkByParameterLimit(revisionIds)) {
      itemRows.push(
        ...(await db
          .select()
          .from(nutritionMealItems)
          .where(
            inArray(
              nutritionMealItems.mealRevisionId,
              revisionIdChunk,
            ),
          )),
      );
    }
    itemRows.sort(
      (left, right) =>
        left.mealRevisionId.localeCompare(right.mealRevisionId) ||
        left.itemOrdinal - right.itemOrdinal,
    );

    const itemsByRevision = new Map<string, NutritionMealItemView[]>();
    for (const item of itemRows) {
      const current = itemsByRevision.get(item.mealRevisionId) ?? [];
      current.push({
        mealItemId: item.mealItemId,
        name: item.itemNameSnapshot,
        quantity: item.quantity,
        unit: item.unit,
        foodId: item.foodId,
        nutrients: pickNutrients(item),
        assumption: item.assumption,
        confidence: item.confidence as "high" | "medium" | "low",
        dataQualityFlags: item.dataQualityFlags,
      });
      itemsByRevision.set(item.mealRevisionId, current);
    }

    const meals: NutritionMealView[] = mealRows.map((row) => ({
      mealId: row.mealId,
      localDate: row.localDate,
      eatenAt: row.eatenAt,
      timePrecision: row.timePrecision as NutritionMealView["timePrecision"],
      mealType: row.mealType as NutritionMealView["mealType"],
      contextTag: row.contextTag,
      originalMealType: row.originalMealType,
      source: row.source,
      confidence: row.confidence as NutritionMealView["confidence"],
      revisionNo: row.revisionNo,
      originalText: row.originalText,
      notes: row.notes,
      nutrients: pickNutrients(row),
      items: itemsByRevision.get(row.mealRevisionId) ?? [],
    }));

    const energyRows = await db
      .select()
      .from(nutritionEnergyObservations)
      .where(eq(nutritionEnergyObservations.localDate, localDate));
    const latestEnergy = energyRows.reduce<
      (typeof energyRows)[number] | null
    >(
      (current, candidate) =>
        preferredEnergyObservation(current, candidate),
      null,
    );

    const settingRows = await db
      .select()
      .from(nutritionSettings)
      .where(
        and(
          lte(nutritionSettings.effectiveFrom, localDate),
          ne(nutritionSettings.status, "retired"),
        ),
      )
      .orderBy(
        desc(nutritionSettings.effectiveFrom),
        desc(nutritionSettings.createdAt),
        desc(nutritionSettings.settingsId),
      )
      .limit(1);
    const settings = settingRows[0] ?? null;

    const bmrRows = await db
      .select({
        measuredAt: bodyMeasurements.measuredAt,
        localDate: bodyMeasurements.localDate,
        bmrKcalPerDay: bodyMeasurements.bmrKcalPerDay,
      })
      .from(bodyMeasurements)
      .where(
        and(
          isNotNull(bodyMeasurements.bmrKcalPerDay),
          lte(bodyMeasurements.localDate, localDate),
        ),
      )
      .orderBy(
        desc(bodyMeasurements.localDate),
        desc(bodyMeasurements.measuredAt),
      )
      .limit(1);
    const bmr = bmrRows[0]?.bmrKcalPerDay ?? null;

    const dailyNutrients = sumNutrients(
      meals.map((meal) => meal.nutrients),
    );
    const hasMeals = meals.length > 0;
    const energyComplete =
      hasMeals &&
      meals.every((meal) => meal.nutrients.energyKcal !== null);
    const activityState: NutritionActivityState = latestEnergy
      ? latestEnergy.status === "final"
        ? "final"
        : "provisional"
      : "missing";
    const { intakeState, settlementState } =
      deriveNutritionDayState({
        hasMeals,
        mealEnergyKnown: energyComplete,
        activityState,
      });
    const {
      targetKcal,
      consumedKcal,
      remainingKcal,
      targetVarianceKcal,
      estimatedExpenditureKcal,
      estimatedBalanceKcal,
    } = deriveNutritionFigures({
      hasMeals,
      mealEnergyKnown: energyComplete,
      dailyEnergyKcal: dailyNutrients.energyKcal,
      calorieTargetKcal: settings?.calorieTargetKcal ?? null,
      bmrKcal: bmr,
      dailyDeficitKcal: settings?.dailyDeficitKcal ?? null,
      activeEnergyCreditRate:
        settings?.activeEnergyCreditRate ?? null,
      activeEnergyKcal: latestEnergy?.activeEnergyKcal ?? null,
      basalEnergyKcal: latestEnergy?.basalEnergyKcal ?? null,
    });

    const trendStartDate = startDateForWindow(localDate, 14);
    const sevenDayStartDate = startDateForWindow(localDate, 7);
    const historyRows = await db
      .select({
        localDate: nutritionMeals.localDate,
        energyKcal: nutritionMealRevisions.energyKcal,
        proteinG: nutritionMealRevisions.proteinG,
      })
      .from(nutritionMeals)
      .innerJoin(
        nutritionMealRevisions,
        and(
          eq(nutritionMealRevisions.mealId, nutritionMeals.mealId),
          eq(
            nutritionMealRevisions.revisionNo,
            nutritionMeals.currentRevisionNo,
          ),
        ),
      )
      .where(
        and(
          between(nutritionMeals.localDate, trendStartDate, localDate),
          isNull(nutritionMeals.voidedAt),
        ),
      );

    const historyByDate = new Map<
      string,
      { energy: Array<number | null>; protein: Array<number | null> }
    >();
    for (const row of historyRows) {
      const current = historyByDate.get(row.localDate) ?? {
        energy: [],
        protein: [],
      };
      current.energy.push(row.energyKcal);
      current.protein.push(row.proteinG);
      historyByDate.set(row.localDate, current);
    }

    const sevenDayEntries = [...historyByDate.entries()].filter(
      ([date]) => date >= sevenDayStartDate,
    );
    const completeEnergyDays = sevenDayEntries
      .map(([, day]) =>
        day.energy.every((value) => value !== null)
          ? day.energy.reduce<number>(
              (total, value) => total + (value ?? 0),
              0,
            )
          : null,
      )
      .filter((value): value is number => value !== null);
    const completeProteinDays = sevenDayEntries
      .map(([, day]) =>
        day.protein.every((value) => value !== null)
          ? day.protein.reduce<number>(
              (total, value) => total + (value ?? 0),
              0,
            )
          : null,
      )
      .filter((value): value is number => value !== null);

    const trendEnergyRows = await db
      .select()
      .from(nutritionEnergyObservations)
      .where(
        between(
          nutritionEnergyObservations.localDate,
          trendStartDate,
          localDate,
        ),
      )
      .orderBy(
        asc(nutritionEnergyObservations.localDate),
        asc(nutritionEnergyObservations.observedAt),
        asc(nutritionEnergyObservations.createdAt),
      );
    const energyByDate = new Map<
      string,
      (typeof trendEnergyRows)[number]
    >();
    for (const row of trendEnergyRows) {
      energyByDate.set(
        row.localDate,
        preferredEnergyObservation(
          energyByDate.get(row.localDate) ?? null,
          row,
        ),
      );
    }

    const trendSettingRows = await db
      .select()
      .from(nutritionSettings)
      .where(
        and(
          lte(nutritionSettings.effectiveFrom, localDate),
          ne(nutritionSettings.status, "retired"),
        ),
      )
      .orderBy(
        asc(nutritionSettings.effectiveFrom),
        asc(nutritionSettings.createdAt),
        asc(nutritionSettings.settingsId),
      );
    const trendBmrRows = await db
      .select({
        measuredAt: bodyMeasurements.measuredAt,
        localDate: bodyMeasurements.localDate,
        bmrKcalPerDay: bodyMeasurements.bmrKcalPerDay,
      })
      .from(bodyMeasurements)
      .where(
        and(
          isNotNull(bodyMeasurements.bmrKcalPerDay),
          lte(bodyMeasurements.localDate, localDate),
        ),
      )
      .orderBy(
        asc(bodyMeasurements.localDate),
        asc(bodyMeasurements.measuredAt),
      );

    let settingIndex = 0;
    let bmrIndex = 0;
    let trendSettings: (typeof trendSettingRows)[number] | null = null;
    let trendBmr: number | null = null;
    const trendDays: NutritionTrendDay[] = dateWindow(
      localDate,
      14,
    ).map((date) => {
      while (
        settingIndex < trendSettingRows.length &&
        trendSettingRows[settingIndex].effectiveFrom <= date
      ) {
        trendSettings = trendSettingRows[settingIndex];
        settingIndex += 1;
      }
      while (
        bmrIndex < trendBmrRows.length
      ) {
        const row = trendBmrRows[bmrIndex];
        if (!row.localDate || row.localDate > date) break;
        trendBmr = row.bmrKcalPerDay;
        bmrIndex += 1;
      }

      const mealValues = historyByDate.get(date);
      const energyKcal =
        mealValues && mealValues.energy.every((value) => value !== null)
          ? round(
              mealValues.energy.reduce<number>(
                (total, value) => total + (value ?? 0),
                0,
              ),
            )
          : null;
      const proteinG =
        mealValues && mealValues.protein.every((value) => value !== null)
          ? round(
              mealValues.protein.reduce<number>(
                (total, value) => total + (value ?? 0),
                0,
              ),
            )
          : null;
      const dayEnergy = energyByDate.get(date) ?? null;
      const energyTargetKcal = trendSettings?.calorieTargetKcal ??
        (trendSettings && trendBmr !== null
          ? Math.round(
              trendBmr -
                trendSettings.dailyDeficitKcal +
                (dayEnergy?.activeEnergyKcal ?? 0) *
                  trendSettings.activeEnergyCreditRate,
            )
          : null);

      return {
        localDate: date,
        energyKcal,
        energyTargetKcal,
        proteinG,
        proteinTargetG: trendSettings?.proteinTargetG ?? null,
        activityState:
          dayEnergy?.status === "final"
            ? "final"
            : dayEnergy
              ? "provisional"
              : "missing",
      };
    });

    return {
      status: meals.length > 0 ? "ready" : "empty",
      localDate,
      intakeState,
      activityState,
      settlementState,
      ruleState:
        settings?.status === "active"
          ? "active"
          : settings
            ? "provisional"
            : null,
      budget: {
        bmrKcal: bmr,
        targetKcal,
        consumedKcal,
        remainingKcal: hasMeals ? remainingKcal : null,
        targetVarianceKcal: hasMeals ? targetVarianceKcal : null,
        estimatedExpenditureKcal,
        estimatedBalanceKcal: hasMeals ? estimatedBalanceKcal : null,
        isComplete: energyComplete,
        isProvisional: settlementState !== "final",
        basis:
          settings?.calorieTargetKcal !== null &&
          settings?.calorieTargetKcal !== undefined
            ? "fixed_daily_target"
            : settings && bmr !== null
              ? "bmr_deficit_plus_active_energy"
              : null,
      },
      protein: {
        consumedG: hasMeals ? dailyNutrients.proteinG : null,
        targetG: settings?.proteinTargetG ?? null,
      },
      activeEnergy: {
        kcal: latestEnergy?.activeEnergyKcal ?? null,
        observedAt: latestEnergy?.observedAt ?? null,
        status:
          (latestEnergy?.status as "provisional" | "final" | undefined) ??
          null,
        source: latestEnergy?.source ?? null,
      },
      nutrients: dailyNutrients,
      meals,
      sevenDay: {
        loggedDays: sevenDayEntries.length,
        averageEnergyKcal:
          completeEnergyDays.length > 0
            ? Math.round(
                completeEnergyDays.reduce(
                  (total, value) => total + value,
                  0,
                ) / completeEnergyDays.length,
              )
            : null,
        averageProteinG:
          completeProteinDays.length > 0
            ? round(
                completeProteinDays.reduce(
                  (total, value) => total + value,
                  0,
                ) / completeProteinDays.length,
                1,
              )
            : null,
      },
      trend: {
        days: trendDays,
      },
      message:
        meals.length === 0
          ? "NO_MEALS_RECORDED"
          : null,
    };
  } catch (error) {
    console.error("Nutrition dashboard unavailable", error);
    return {
      status: "unavailable",
      localDate,
      intakeState: "no_record",
      activityState: "missing",
      settlementState: "unavailable",
      ruleState: null,
      budget: {
        bmrKcal: null,
        targetKcal: null,
        consumedKcal: null,
        remainingKcal: null,
        targetVarianceKcal: null,
        estimatedExpenditureKcal: null,
        estimatedBalanceKcal: null,
        isComplete: false,
        isProvisional: true,
        basis: null,
      },
      protein: { consumedG: null, targetG: null },
      activeEnergy: {
        kcal: null,
        observedAt: null,
        status: null,
        source: null,
      },
      nutrients: nullNutrients(),
      meals: [],
      sevenDay: {
        loggedDays: 0,
        averageEnergyKcal: null,
        averageProteinG: null,
      },
      trend: {
        days: [],
      },
      message: "NUTRITION_DATA_UNAVAILABLE",
    };
  }
}
