import { and, asc, between, desc, eq, isNull, lte, ne } from "drizzle-orm";

import { getDb } from "@/db";
import {
  bodyMeasurements,
  nutritionEnergyObservations,
  nutritionMealRevisions,
  nutritionMeals,
  nutritionSettings,
} from "@/db/schema";
import {
  getApiActor,
  routeError,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { apiError } from "@/lib/api-error";
import {
  CALIBRATION_WINDOW_DAYS,
  deriveNutritionCalibration,
  NUTRITION_CALIBRATION_CONTRACT_VERSION,
} from "@/lib/nutrition-calibration";
import { preferredEnergyObservation } from "@/lib/nutrition-state";
import { nutritionTargetResponse } from "@/lib/nutrition-targets";
import { getProfileTimezone } from "@/lib/profile-timezone";
import { isDateOnly } from "@/lib/record-utils";
import { dateInTimeZone } from "@/lib/timezone.mjs";

export const dynamic = "force-dynamic";

function noStore(response: Response) {
  response.headers.set("cache-control", "no-store");
  return response;
}

function shiftDate(localDate: string, days: number) {
  const value = new Date(`${localDate}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function dateWindow(from: string, to: string) {
  const values: string[] = [];
  for (let value = from; value <= to; value = shiftDate(value, 1)) {
    values.push(value);
  }
  return values;
}

export async function GET(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return noStore(unauthorizedResponse());

    const timezone = await getProfileTimezone();
    const to =
      new URL(request.url).searchParams.get("asOf") ??
      dateInTimeZone(new Date(), timezone);
    if (!isDateOnly(to)) {
      return noStore(
        apiError(
          "INVALID_CALIBRATION_DATE",
          400,
          { field: "asOf", expected: "YYYY-MM-DD" },
          "Invalid calibration date",
        ),
      );
    }
    const db = getDb();
    const targetRows = await db
      .select()
      .from(nutritionSettings)
      .where(
        and(
          lte(nutritionSettings.effectiveFrom, to),
          ne(nutritionSettings.status, "retired"),
        ),
      )
      .orderBy(
        desc(nutritionSettings.effectiveFrom),
        desc(nutritionSettings.createdAt),
        desc(nutritionSettings.settingsId),
      )
      .limit(1);
    const requestedFrom = shiftDate(to, -(CALIBRATION_WINDOW_DAYS - 1));
    const from =
      targetRows[0]?.effectiveFrom &&
      targetRows[0].effectiveFrom > requestedFrom
        ? targetRows[0].effectiveFrom
        : requestedFrom;
    const [mealRows, energyRows, measurementRows] =
      await Promise.all([
        db
          .select({
            localDate: nutritionMeals.localDate,
            energyKcal: nutritionMealRevisions.energyKcal,
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
              between(nutritionMeals.localDate, from, to),
              isNull(nutritionMeals.voidedAt),
            ),
          ),
        db
          .select()
          .from(nutritionEnergyObservations)
          .where(
            between(nutritionEnergyObservations.localDate, from, to),
          )
          .orderBy(
            asc(nutritionEnergyObservations.localDate),
            asc(nutritionEnergyObservations.observedAt),
            asc(nutritionEnergyObservations.createdAt),
          ),
        db
          .select({
            localDate: bodyMeasurements.localDate,
            measuredAt: bodyMeasurements.measuredAt,
            weightKg: bodyMeasurements.weightKg,
            bmrKcalPerDay: bodyMeasurements.bmrKcalPerDay,
          })
          .from(bodyMeasurements)
          .where(lte(bodyMeasurements.localDate, to))
          .orderBy(
            asc(bodyMeasurements.localDate),
            asc(bodyMeasurements.measuredAt),
          ),
      ]);

    const mealsByDate = new Map<string, Array<number | null>>();
    for (const row of mealRows) {
      const values = mealsByDate.get(row.localDate) ?? [];
      values.push(row.energyKcal);
      mealsByDate.set(row.localDate, values);
    }
    const energyByDate = new Map<
      string,
      (typeof energyRows)[number]
    >();
    for (const row of energyRows) {
      energyByDate.set(
        row.localDate,
        preferredEnergyObservation(
          energyByDate.get(row.localDate) ?? null,
          row,
        ),
      );
    }

    let measurementIndex = 0;
    let currentBmr: number | null = null;
    const days = dateWindow(from, to).map((localDate) => {
      while (
        measurementIndex < measurementRows.length &&
        (measurementRows[measurementIndex].localDate ?? "") <= localDate
      ) {
        currentBmr =
          measurementRows[measurementIndex].bmrKcalPerDay ?? currentBmr;
        measurementIndex += 1;
      }
      const meals = mealsByDate.get(localDate) ?? [];
      const mealEnergyComplete =
        meals.length > 0 && meals.every((value) => value !== null);
      const energy = energyByDate.get(localDate) ?? null;
      return {
        localDate,
        intakeKcal: mealEnergyComplete
          ? meals.reduce<number>((total, value) => total + (value ?? 0), 0)
          : null,
        mealEnergyComplete,
        activeEnergyKcal: energy?.activeEnergyKcal ?? null,
        activityFinal: energy?.status === "final",
        bmrKcal: currentBmr,
      };
    });
    const weights = measurementRows
      .filter(
        (row) =>
          row.localDate !== null &&
          row.localDate >= from &&
          row.localDate <= to,
      )
      .map((row) => ({
        localDate: row.localDate!,
        weightKg: row.weightKg,
      }));

    return noStore(
      Response.json({
        contractVersion: NUTRITION_CALIBRATION_CONTRACT_VERSION,
        actor: actor.kind,
        asOf: to,
        currentTarget: targetRows[0]
          ? nutritionTargetResponse(targetRows[0])
          : null,
        calibration: deriveNutritionCalibration({ from, to, days, weights }),
        policy: {
          autoApply: false,
          confirmationRequired: true,
          writeResource: "nutrition_targets",
        },
      }),
    );
  } catch (error) {
    return noStore(routeError(error));
  }
}
