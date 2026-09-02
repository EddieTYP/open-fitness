import {
  effectiveTrainingCycleConfig,
  inferSessionTrainingPhaseId,
  normaliseTrainingCycleConfig,
  parseStoredTrainingCycleConfig,
  type CyclePhase,
  type TrainingCycleConfig,
} from "./training-cycle.ts";
import {
  APP_LOCALES,
  DEFAULT_APP_LOCALE,
  isAppLocale,
  type AppLocale,
} from "./i18n/locales.ts";
import { isSupportedTimeZone } from "./timezone.mjs";
import {
  normaliseNutritionTarget,
  nutritionTargetResponse,
  type NutritionTargetInput,
  type NutritionTargetRecord,
} from "./nutrition-targets.ts";

export const GOAL_TYPES = [
  "fat_loss",
  "muscle_gain",
  "strength",
  "endurance",
  "maintenance",
  "general",
] as const;

export type GoalType = (typeof GOAL_TYPES)[number];

export type ProfilePatch = {
  expectedUpdatedAt: string;
  displayName?: string;
  primaryGoal?: string;
  goalType?: GoalType;
  trainingBlockChangeReason?: string;
  trainingCycleConfig?: TrainingCycleConfig;
  strengthProgressExercise?: string | null;
  heightCm?: number | null;
  timezone?: string;
  preferredLocale?: AppLocale;
  nutritionTarget?: NutritionTargetInput;
  setupCompleted?: boolean;
};

export type ProfileRecord = {
  profileId: string;
  displayName: string | null;
  primaryGoal: string;
  goalType: GoalType | null;
  trainingCycle: string;
  trainingCycleConfig: string | null;
  strengthProgressExercise: string | null;
  heightCm: number | null;
  timezone: string;
  preferredLocale: string;
  setupCompleted: boolean;
  updatedAt: string;
};

export type TrainingBlockRecord = {
  blockId: string;
  goalType: GoalType;
  primaryGoal: string;
  trainingCycleSnapshot: string;
  startsOn: string;
  endsOn: string | null;
  changeReason: string;
  createdAt: string;
};

export class ProfileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileValidationError";
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProfileValidationError("profile patch must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredText(
  value: unknown,
  path: string,
  maximumLength: number,
): string {
  if (typeof value !== "string") {
    throw new ProfileValidationError(`${path} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximumLength) {
    throw new ProfileValidationError(
      `${path} must contain 1 to ${maximumLength} characters`,
    );
  }
  return normalized;
}

function nullableText(
  value: unknown,
  path: string,
  maximumLength: number,
): string | null {
  if (value === null) return null;
  return requiredText(value, path, maximumLength);
}

function isGoalType(value: unknown): value is GoalType {
  return typeof value === "string" && GOAL_TYPES.includes(value as GoalType);
}

export function classifyGoalType(primaryGoal: string | null | undefined): GoalType {
  const value = (primaryGoal ?? "").normalize("NFKC").toLowerCase();
  if (
    value.includes("fat loss") ||
    value.includes("weight loss") ||
    value.includes("body fat") ||
    value.includes("reduce fat") ||
    value.includes("減脂")
  ) {
    return "fat_loss";
  }
  if (
    value.includes("muscle") ||
    value.includes("hypertrophy") ||
    value.includes("增肌")
  ) {
    return "muscle_gain";
  }
  if (value.includes("strength") || value.includes("力量")) return "strength";
  if (
    value.includes("endurance") ||
    value.includes("cardio") ||
    value.includes("耐力")
  ) {
    return "endurance";
  }
  if (value.includes("maintain") || value.includes("維持")) {
    return "maintenance";
  }
  return "general";
}

export function goalTypeLabel(goalType: GoalType): string {
  const labels: Record<GoalType, string> = {
    fat_loss: "Fat loss",
    muscle_gain: "Muscle gain",
    strength: "Strength",
    endurance: "Endurance",
    maintenance: "Maintenance",
    general: "General fitness",
  };
  return labels[goalType];
}

export function normaliseProfilePatch(value: unknown): ProfilePatch {
  const payload = objectValue(value);
  const allowed = [
    "expectedUpdatedAt",
    "displayName",
    "primaryGoal",
    "goalType",
    "trainingBlockChangeReason",
    "trainingCycleConfig",
    "strengthProgressExercise",
    "heightCm",
    "timezone",
    "preferredLocale",
    "nutritionTarget",
    "setupCompleted",
  ];
  const unknown = Object.keys(payload).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new ProfileValidationError(
      `profile patch contains unknown field(s): ${unknown.join(", ")}`,
    );
  }
  const expectedUpdatedAt = requiredText(
    payload.expectedUpdatedAt,
    "expectedUpdatedAt",
    100,
  );
  if (Object.keys(payload).length === 1) {
    throw new ProfileValidationError("profile patch has no changes");
  }

  const patch: ProfilePatch = { expectedUpdatedAt };
  if (Object.hasOwn(payload, "displayName")) {
    patch.displayName = requiredText(payload.displayName, "displayName", 80);
  }
  if (Object.hasOwn(payload, "primaryGoal")) {
    patch.primaryGoal = requiredText(payload.primaryGoal, "primaryGoal", 500);
  }
  if (Object.hasOwn(payload, "goalType")) {
    if (!isGoalType(payload.goalType)) {
      throw new ProfileValidationError(
        `goalType must be one of ${GOAL_TYPES.join(", ")}`,
      );
    }
    patch.goalType = payload.goalType;
  }
  if (Object.hasOwn(payload, "trainingBlockChangeReason")) {
    patch.trainingBlockChangeReason = requiredText(
      payload.trainingBlockChangeReason,
      "trainingBlockChangeReason",
      500,
    );
  }
  if (Object.hasOwn(payload, "trainingCycleConfig")) {
    patch.trainingCycleConfig = normaliseTrainingCycleConfig(
      payload.trainingCycleConfig,
    );
  }
  if (Object.hasOwn(payload, "strengthProgressExercise")) {
    patch.strengthProgressExercise = nullableText(
      payload.strengthProgressExercise,
      "strengthProgressExercise",
      120,
    );
  }
  if (Object.hasOwn(payload, "heightCm")) {
    const heightCm = payload.heightCm;
    if (
      heightCm !== null &&
      (typeof heightCm !== "number" ||
        !Number.isFinite(heightCm) ||
        heightCm < 80 ||
        heightCm > 250)
    ) {
      throw new ProfileValidationError(
        "heightCm must be null or a number from 80 to 250",
      );
    }
    patch.heightCm = heightCm as number | null;
  }
  if (Object.hasOwn(payload, "timezone")) {
    if (!isSupportedTimeZone(payload.timezone)) {
      throw new ProfileValidationError("timezone must be a valid IANA timezone");
    }
    patch.timezone = (payload.timezone as string).trim();
  }
  if (Object.hasOwn(payload, "preferredLocale")) {
    if (!isAppLocale(payload.preferredLocale)) {
      throw new ProfileValidationError(
        `preferredLocale must be one of ${APP_LOCALES.join(", ")}`,
      );
    }
    patch.preferredLocale = payload.preferredLocale;
  }
  if (Object.hasOwn(payload, "nutritionTarget")) {
    patch.nutritionTarget = normaliseNutritionTarget(payload.nutritionTarget);
  }
  if (Object.hasOwn(payload, "setupCompleted")) {
    if (typeof payload.setupCompleted !== "boolean") {
      throw new ProfileValidationError("setupCompleted must be a boolean");
    }
    patch.setupCompleted = payload.setupCompleted;
  }
  return patch;
}

export function profileResponse(
  record: ProfileRecord,
  nutritionTarget: NutritionTargetRecord | null = null,
  currentTrainingBlock: TrainingBlockRecord | null = null,
) {
  const storedConfig = parseStoredTrainingCycleConfig(
    record.trainingCycleConfig,
  );
  return {
    profileId: record.profileId,
    displayName: record.displayName,
    primaryGoal: record.primaryGoal,
    goalType: record.goalType ?? classifyGoalType(record.primaryGoal),
    trainingCycle: record.trainingCycle,
    trainingCycleConfig:
      storedConfig ?? effectiveTrainingCycleConfig(record.trainingCycle),
    trainingCycleSource: storedConfig ? ("structured" as const) : ("legacy" as const),
    strengthProgressExercise: record.strengthProgressExercise,
    heightCm: record.heightCm,
    timezone: record.timezone,
    preferredLocale: isAppLocale(record.preferredLocale)
      ? record.preferredLocale
      : DEFAULT_APP_LOCALE,
    nutritionTarget: nutritionTarget
      ? nutritionTargetResponse(nutritionTarget)
      : null,
    currentTrainingBlock: currentTrainingBlock
      ? {
          blockId: currentTrainingBlock.blockId,
          goalType: currentTrainingBlock.goalType,
          primaryGoal: currentTrainingBlock.primaryGoal,
          startsOn: currentTrainingBlock.startsOn,
          changeReason: currentTrainingBlock.changeReason,
          createdAt: currentTrainingBlock.createdAt,
        }
      : null,
    setupCompleted: record.setupCompleted,
    updatedAt: record.updatedAt,
  };
}

export function profileUpdateValues(patch: ProfilePatch, updatedAt: string) {
  const values: {
    displayName?: string;
    primaryGoal?: string;
    goalType?: GoalType;
    trainingCycle?: string;
    trainingCycleConfig?: string;
    strengthProgressExercise?: string | null;
    heightCm?: number | null;
    timezone?: string;
    preferredLocale?: AppLocale;
    setupCompleted?: boolean;
    updatedAt: string;
  } = { updatedAt };
  if (patch.displayName !== undefined) values.displayName = patch.displayName;
  if (patch.primaryGoal !== undefined) values.primaryGoal = patch.primaryGoal;
  if (patch.goalType !== undefined) {
    values.goalType = patch.goalType;
  }
  if (patch.trainingCycleConfig !== undefined) {
    values.trainingCycleConfig = JSON.stringify(patch.trainingCycleConfig);
    values.trainingCycle = patch.trainingCycleConfig.phases
      .map((phase) => phase.label)
      .join(" / ");
  }
  if (patch.strengthProgressExercise !== undefined) {
    values.strengthProgressExercise = patch.strengthProgressExercise;
  }
  if (patch.heightCm !== undefined) values.heightCm = patch.heightCm;
  if (patch.timezone !== undefined) values.timezone = patch.timezone;
  if (patch.preferredLocale !== undefined) {
    values.preferredLocale = patch.preferredLocale;
  }
  if (patch.setupCompleted !== undefined) {
    values.setupCompleted = patch.setupCompleted;
  }
  return values;
}

export function inferTrainingPhaseBackfills(
  currentPhases: CyclePhase[],
  sessions: readonly {
    sessionId: string;
    sessionTitle: string;
    sessionType?: string | null;
  }[],
) {
  return sessions.flatMap((session) => {
    const trainingPhaseId = inferSessionTrainingPhaseId(
      currentPhases,
      session.sessionTitle,
      session.sessionType,
    );
    return trainingPhaseId
      ? [{ sessionId: session.sessionId, trainingPhaseId }]
      : [];
  });
}

export function assertStablePhaseKinds(
  current: TrainingCycleConfig,
  next: TrainingCycleConfig,
) {
  const currentKinds = new Map(
    current.phases.map((phase) => [phase.id, phase.kind] as const),
  );
  for (const phase of next.phases) {
    const previousKind = currentKinds.get(phase.id);
    if (previousKind !== undefined && previousKind !== phase.kind) {
      throw new ProfileValidationError(
        `trainingCycleConfig phase ${phase.id} cannot change kind; use a new id`,
      );
    }
  }
}

export function nextProfileUpdatedAt(
  previous: string,
  now = new Date(),
): string {
  const previousMs = Date.parse(previous);
  const nowMs = now.getTime();
  return new Date(
    Number.isFinite(previousMs) && nowMs <= previousMs ? previousMs + 1 : nowMs,
  ).toISOString();
}
