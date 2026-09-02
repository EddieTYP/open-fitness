export const NUTRITION_CALIBRATION_CONTRACT_VERSION = "2026-08-21.1";
export const CALIBRATION_WINDOW_DAYS = 28;
export const CALIBRATION_MIN_COMPLETE_DAYS = 14;
export const CALIBRATION_MIN_WEIGHT_DAYS = 6;
export const CALIBRATION_MIN_WEIGHT_SPAN_DAYS = 14;
export const CALIBRATION_KCAL_PER_KG = 7700;

export type NutritionCalibrationDay = {
  localDate: string;
  intakeKcal: number | null;
  mealEnergyComplete: boolean;
  activeEnergyKcal: number | null;
  activityFinal: boolean;
  bmrKcal: number | null;
};

export type NutritionCalibrationWeight = {
  localDate: string;
  weightKg: number;
};

function round(value: number, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values: number[]) {
  return values.length > 0
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null;
}

function daysBetween(from: string, to: string) {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );
}

export function deriveNutritionCalibration({
  from,
  to,
  days,
  weights,
}: {
  from: string;
  to: string;
  days: NutritionCalibrationDay[];
  weights: NutritionCalibrationWeight[];
}) {
  const completeDays = days
    .filter(
      (day) =>
        day.intakeKcal !== null &&
        day.mealEnergyComplete &&
        day.activeEnergyKcal !== null &&
        day.activityFinal &&
        day.bmrKcal !== null,
    )
    .sort((left, right) => left.localDate.localeCompare(right.localDate));
  const weightsByDate = new Map<string, NutritionCalibrationWeight>();
  for (const point of [...weights].sort((left, right) =>
    left.localDate.localeCompare(right.localDate),
  )) {
    if (
      point.localDate >= from &&
      point.localDate <= to &&
      Number.isFinite(point.weightKg)
    ) {
      weightsByDate.set(point.localDate, point);
    }
  }
  const orderedWeights = [...weightsByDate.values()]
    .filter(
      (point) =>
        point.localDate >= from &&
        point.localDate <= to &&
        Number.isFinite(point.weightKg),
    )
    .sort((left, right) => left.localDate.localeCompare(right.localDate));
  const weightSpanDays =
    orderedWeights.length > 1
      ? daysBetween(
          orderedWeights[0].localDate,
          orderedWeights.at(-1)!.localDate,
        )
      : 0;
  const reasons: string[] = [];
  if (completeDays.length < CALIBRATION_MIN_COMPLETE_DAYS) {
    reasons.push("INSUFFICIENT_COMPLETE_DAYS");
  }
  if (orderedWeights.length < CALIBRATION_MIN_WEIGHT_DAYS) {
    reasons.push("INSUFFICIENT_WEIGHT_DAYS");
  }
  if (weightSpanDays < CALIBRATION_MIN_WEIGHT_SPAN_DAYS) {
    reasons.push("WEIGHT_SPAN_TOO_SHORT");
  }

  const averageIntakeKcal = mean(
    completeDays.map((day) => day.intakeKcal!),
  );
  const averageActiveEnergyKcal = mean(
    completeDays.map((day) => day.activeEnergyKcal!),
  );
  const averageBmrKcal = mean(completeDays.map((day) => day.bmrKcal!));

  const edgeCount = Math.min(3, Math.floor(orderedWeights.length / 2));
  const startWeightKg =
    edgeCount > 0
      ? mean(orderedWeights.slice(0, edgeCount).map((point) => point.weightKg))
      : null;
  const endWeightKg =
    edgeCount > 0
      ? mean(orderedWeights.slice(-edgeCount).map((point) => point.weightKg))
      : null;
  const weightChangeKg =
    startWeightKg !== null && endWeightKg !== null
      ? endWeightKg - startWeightKg
      : null;
  const weeklyWeightChangeKg =
    weightChangeKg !== null && weightSpanDays > 0
      ? (weightChangeKg / weightSpanDays) * 7
      : null;
  const scaleImpliedDailyDeficitKcal =
    weightChangeKg !== null && weightSpanDays > 0
      ? (-weightChangeKg * CALIBRATION_KCAL_PER_KG) / weightSpanDays
      : null;
  const impliedActiveEnergyCreditRate =
    scaleImpliedDailyDeficitKcal !== null &&
    averageIntakeKcal !== null &&
    averageBmrKcal !== null &&
    averageActiveEnergyKcal !== null &&
    averageActiveEnergyKcal > 0
      ? (averageIntakeKcal +
          scaleImpliedDailyDeficitKcal -
          averageBmrKcal) /
        averageActiveEnergyKcal
      : null;

  return {
    readiness: reasons.length === 0 ? "ready_for_review" : "needs_more_data",
    reasons,
    window: {
      from,
      to,
      requestedDays: daysBetween(from, to) + 1,
      loggedDays: days.filter((day) => day.intakeKcal !== null).length,
      completeDays: completeDays.length,
      firstCompleteDate: completeDays[0]?.localDate ?? null,
      lastCompleteDate: completeDays.at(-1)?.localDate ?? null,
      weightDays: orderedWeights.length,
      weightSpanDays,
    },
    observed: {
      averageIntakeKcal:
        averageIntakeKcal === null ? null : round(averageIntakeKcal),
      averageActiveEnergyKcal:
        averageActiveEnergyKcal === null
          ? null
          : round(averageActiveEnergyKcal),
      averageBmrKcal:
        averageBmrKcal === null ? null : round(averageBmrKcal),
      startWeightKg:
        startWeightKg === null ? null : round(startWeightKg, 2),
      endWeightKg: endWeightKg === null ? null : round(endWeightKg, 2),
      weightChangeKg:
        weightChangeKg === null ? null : round(weightChangeKg, 2),
      weeklyWeightChangeKg:
        weeklyWeightChangeKg === null
          ? null
          : round(weeklyWeightChangeKg, 2),
    },
    estimates: {
      kcalPerKgAssumption: CALIBRATION_KCAL_PER_KG,
      scaleImpliedDailyDeficitKcal:
        scaleImpliedDailyDeficitKcal === null
          ? null
          : round(scaleImpliedDailyDeficitKcal),
      impliedActiveEnergyCreditRate:
        impliedActiveEnergyCreditRate === null
          ? null
          : round(impliedActiveEnergyCreditRate, 3),
      caveat:
        "Scale-derived estimates are noisy and cannot separate water change, intake error, and wearable error; review rather than auto-apply.",
    },
  } as const;
}
