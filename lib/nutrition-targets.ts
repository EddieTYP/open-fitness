export const NUTRITION_TARGET_CONTRACT_VERSION = "2026-08-21.1";
export const CALORIE_TARGET_MIN_KCAL = 500;
export const CALORIE_TARGET_MAX_KCAL = 6000;
export const PROTEIN_TARGET_MAX_G = 500;
export const DAILY_DEFICIT_MAX_KCAL = 2000;

export type FixedNutritionTargetInput = {
  mode?: "fixed";
  effectiveFrom: string;
  calorieTargetKcal: number;
  proteinTargetG: number;
};

export type FormulaNutritionTargetInput = {
  mode: "formula";
  effectiveFrom: string;
  dailyDeficitKcal: number;
  activeEnergyCreditRate: number;
  proteinTargetG: number;
  expectedSettingsId: string;
};

export type NutritionTargetInput =
  | FixedNutritionTargetInput
  | FormulaNutritionTargetInput;

export type NutritionTargetRecord = {
  settingsId: string;
  effectiveFrom: string;
  status: string;
  calorieTargetKcal: number | null;
  dailyDeficitKcal: number;
  activeEnergyCreditRate: number;
  proteinTargetG: number;
  saturatedFatLimitG: number | null;
  sodiumLimitMg: number | null;
  sourceNote: string;
  createdAt: string;
};

export class NutritionTargetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NutritionTargetValidationError";
  }
}

export class NutritionTargetConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NutritionTargetConflictError";
  }
}

export function assertExpectedNutritionTarget(
  target: NutritionTargetInput,
  inherited: NutritionTargetRecord | null,
) {
  if (
    target.mode === "formula" &&
    inherited?.settingsId !== target.expectedSettingsId
  ) {
    throw new NutritionTargetConflictError(
      "expectedSettingsId does not match the effective target",
    );
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NutritionTargetValidationError(
      "nutritionTarget must be an object",
    );
  }
  return value as Record<string, unknown>;
}

function isDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export function normaliseNutritionTarget(
  value: unknown,
): NutritionTargetInput {
  const payload = objectValue(value);
  const mode = payload.mode === undefined ? "fixed" : payload.mode;
  if (mode !== "fixed" && mode !== "formula") {
    throw new NutritionTargetValidationError(
      'nutritionTarget.mode must be "fixed" or "formula"',
    );
  }
  const allowed =
    mode === "fixed"
      ? ["mode", "effectiveFrom", "calorieTargetKcal", "proteinTargetG"]
      : [
          "mode",
          "effectiveFrom",
          "dailyDeficitKcal",
          "activeEnergyCreditRate",
          "proteinTargetG",
          "expectedSettingsId",
        ];
  const unknown = Object.keys(payload).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new NutritionTargetValidationError(
      `nutritionTarget contains unknown field(s): ${unknown.join(", ")}`,
    );
  }

  if (!isDateOnly(payload.effectiveFrom)) {
    throw new NutritionTargetValidationError(
      "nutritionTarget.effectiveFrom must use YYYY-MM-DD",
    );
  }
  if (
    typeof payload.proteinTargetG !== "number" ||
    !Number.isFinite(payload.proteinTargetG) ||
    payload.proteinTargetG <= 0 ||
    payload.proteinTargetG > PROTEIN_TARGET_MAX_G
  ) {
    throw new NutritionTargetValidationError(
      `nutritionTarget.proteinTargetG must be greater than 0 and at most ${PROTEIN_TARGET_MAX_G}`,
    );
  }

  if (mode === "fixed") {
    if (
      typeof payload.calorieTargetKcal !== "number" ||
      !Number.isFinite(payload.calorieTargetKcal) ||
      !Number.isInteger(payload.calorieTargetKcal) ||
      payload.calorieTargetKcal < CALORIE_TARGET_MIN_KCAL ||
      payload.calorieTargetKcal > CALORIE_TARGET_MAX_KCAL
    ) {
      throw new NutritionTargetValidationError(
        `nutritionTarget.calorieTargetKcal must be an integer from ${CALORIE_TARGET_MIN_KCAL} to ${CALORIE_TARGET_MAX_KCAL}`,
      );
    }
    return {
      ...(payload.mode === "fixed" ? { mode: "fixed" as const } : {}),
      effectiveFrom: payload.effectiveFrom,
      calorieTargetKcal: payload.calorieTargetKcal,
      proteinTargetG: payload.proteinTargetG,
    };
  }

  if (
    typeof payload.dailyDeficitKcal !== "number" ||
    !Number.isFinite(payload.dailyDeficitKcal) ||
    !Number.isInteger(payload.dailyDeficitKcal) ||
    payload.dailyDeficitKcal < 0 ||
    payload.dailyDeficitKcal > DAILY_DEFICIT_MAX_KCAL
  ) {
    throw new NutritionTargetValidationError(
      `nutritionTarget.dailyDeficitKcal must be an integer from 0 to ${DAILY_DEFICIT_MAX_KCAL}`,
    );
  }
  if (
    typeof payload.activeEnergyCreditRate !== "number" ||
    !Number.isFinite(payload.activeEnergyCreditRate) ||
    payload.activeEnergyCreditRate < 0 ||
    payload.activeEnergyCreditRate > 1
  ) {
    throw new NutritionTargetValidationError(
      "nutritionTarget.activeEnergyCreditRate must be from 0 to 1",
    );
  }
  if (
    typeof payload.expectedSettingsId !== "string" ||
    payload.expectedSettingsId.trim().length === 0 ||
    payload.expectedSettingsId.length > 200
  ) {
    throw new NutritionTargetValidationError(
      "nutritionTarget.expectedSettingsId is required",
    );
  }
  return {
    mode,
    effectiveFrom: payload.effectiveFrom,
    dailyDeficitKcal: payload.dailyDeficitKcal,
    activeEnergyCreditRate: payload.activeEnergyCreditRate,
    proteinTargetG: payload.proteinTargetG,
    expectedSettingsId: payload.expectedSettingsId.trim(),
  };
}

export function nutritionTargetResponse(record: NutritionTargetRecord) {
  return {
    settingsId: record.settingsId,
    effectiveFrom: record.effectiveFrom,
    mode: record.calorieTargetKcal === null ? "formula" : "fixed",
    calorieTargetKcal: record.calorieTargetKcal,
    dailyDeficitKcal: record.dailyDeficitKcal,
    activeEnergyCreditRate: record.activeEnergyCreditRate,
    proteinTargetG: record.proteinTargetG,
    status: record.status,
    createdAt: record.createdAt,
  };
}

export function nutritionTargetInsertValues(
  target: NutritionTargetInput,
  inherited: NutritionTargetRecord | null,
  settingsId = `NUTRITION-TARGET|${new Date().toISOString()}|${crypto.randomUUID()}`,
) {
  return {
    settingsId,
    effectiveFrom: target.effectiveFrom,
    status: "active",
    calorieTargetKcal:
      target.mode === "fixed" ? target.calorieTargetKcal : null,
    dailyDeficitKcal:
      target.mode === "formula"
        ? target.dailyDeficitKcal
        : inherited?.dailyDeficitKcal ?? 0,
    activeEnergyCreditRate:
      target.mode === "formula"
        ? target.activeEnergyCreditRate
        : inherited?.activeEnergyCreditRate ?? 0.8,
    proteinTargetG: target.proteinTargetG,
    saturatedFatLimitG: inherited?.saturatedFatLimitG ?? null,
    sodiumLimitMg: inherited?.sodiumLimitMg ?? null,
    sourceNote:
      target.mode === "formula"
        ? "Reviewed BMR, deficit, active-energy credit, and protein targets"
        : "Explicit daily intake and protein target",
  } as const;
}
