export type NutritionActivityState =
  | "missing"
  | "provisional"
  | "final";

export type EnergyObservationIdentity = {
  energyObservationId: string;
  observedAt: string | null;
  createdAt: string;
  status: string;
};

export function preferredEnergyObservation<
  T extends EnergyObservationIdentity,
>(current: T | null, candidate: T) {
  if (!current) return candidate;
  const currentRank = current.status === "final" ? 1 : 0;
  const candidateRank = candidate.status === "final" ? 1 : 0;
  if (candidateRank !== currentRank) {
    return candidateRank > currentRank ? candidate : current;
  }
  const currentTime = current.observedAt ?? current.createdAt;
  const candidateTime = candidate.observedAt ?? candidate.createdAt;
  if (candidateTime !== currentTime) {
    return candidateTime > currentTime ? candidate : current;
  }
  return candidate.energyObservationId > current.energyObservationId
    ? candidate
    : current;
}

export function deriveNutritionDayState({
  hasMeals,
  mealEnergyKnown,
  activityState,
}: {
  hasMeals: boolean;
  mealEnergyKnown: boolean;
  activityState: NutritionActivityState;
}) {
  const settlementState: "unavailable" | "provisional" | "final" =
    !mealEnergyKnown || activityState === "missing"
      ? "unavailable"
      : activityState === "final"
        ? "final"
        : "provisional";
  const intakeState: "no_record" | "recording" | "closed" =
    !hasMeals
      ? "no_record"
      : settlementState === "final"
        ? "closed"
        : "recording";
  return { intakeState, settlementState };
}

export function deriveNutritionFigures({
  hasMeals,
  mealEnergyKnown,
  dailyEnergyKcal,
  calorieTargetKcal,
  bmrKcal,
  dailyDeficitKcal,
  activeEnergyCreditRate,
  activeEnergyKcal,
  basalEnergyKcal,
}: {
  hasMeals: boolean;
  mealEnergyKnown: boolean;
  dailyEnergyKcal: number | null;
  calorieTargetKcal?: number | null;
  bmrKcal: number | null;
  dailyDeficitKcal: number | null;
  activeEnergyCreditRate: number | null;
  activeEnergyKcal: number | null;
  basalEnergyKcal: number | null;
}) {
  const targetKcal =
    calorieTargetKcal !== null && calorieTargetKcal !== undefined
      ? Math.round(calorieTargetKcal)
      : bmrKcal !== null &&
          dailyDeficitKcal !== null &&
          activeEnergyCreditRate !== null
        ? Math.round(
            bmrKcal -
              dailyDeficitKcal +
              (activeEnergyKcal ?? 0) * activeEnergyCreditRate,
          )
        : null;
  const consumedKcal =
    hasMeals && mealEnergyKnown ? dailyEnergyKcal : null;
  const remainingKcal =
    targetKcal !== null && consumedKcal !== null
      ? Math.round(targetKcal - consumedKcal)
      : null;
  const targetVarianceKcal =
    targetKcal !== null && consumedKcal !== null
      ? Math.round(consumedKcal - targetKcal)
      : null;
  const estimatedExpenditureKcal =
    activeEnergyKcal !== null &&
    (basalEnergyKcal !== null || bmrKcal !== null)
      ? Math.round(
          (basalEnergyKcal ?? bmrKcal ?? 0) + activeEnergyKcal,
        )
      : null;
  const estimatedBalanceKcal =
    consumedKcal !== null && estimatedExpenditureKcal !== null
      ? Math.round(consumedKcal - estimatedExpenditureKcal)
      : null;

  return {
    targetKcal,
    consumedKcal,
    remainingKcal,
    targetVarianceKcal,
    estimatedExpenditureKcal,
    estimatedBalanceKcal,
  };
}
