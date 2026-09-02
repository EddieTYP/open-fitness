import { isIsoTimestamp } from "@/lib/record-utils";
import {
  DEFAULT_TIMEZONE,
  timestampInTimeZone,
} from "@/lib/timezone.mjs";

export const WORKOUT_CONTRACT_VERSION = "2026-08-23.2";

export const WORKOUT_INPUT_FIELDS = [
  "sessionId",
  "source",
  "sessionIntent",
  "trainingBlockId",
  "trainingPhaseId",
  "title",
  "type",
  "startedAt",
  "endedAt",
  "timePrecision",
  "durationSeconds",
  "totalSetsReported",
  "burnedCaloriesKcalReported",
  "totalTvlKgReported",
  "effortRaw",
  "venueManual",
  "notesManual",
  "activeCaloriesKcal",
  "totalCaloriesKcal",
  "elevationMetres",
  "floorsClimbed",
  "averageRpm",
  "averageHeartRateBpm",
  "zone1Seconds",
  "zone2Seconds",
  "zone3Seconds",
  "zone4Seconds",
  "zone5Seconds",
  "shoulderPainPre010Manual",
  "shoulderPainPost010Manual",
  "fatigueRpe010Manual",
  "sets",
] as const;

export const WORKOUT_SET_INPUT_FIELDS = [
  "setId",
  "exercise",
  "setNoSession",
  "setNoExercise",
  "weightKgReported",
  "reps",
  "timeSeconds",
  "distanceM",
  "restSeconds",
  "effortRaw",
  "setTypeManual",
  "loadBasisManual",
  "pain010Manual",
  "venueManual",
  "coachNote",
  "sourceFile",
] as const;

type JsonObject = Record<string, unknown>;
type NumberOptions = {
  min?: number;
  max?: number;
  optional?: boolean;
  integer?: boolean;
};

export type WorkoutValidationIssue = { path: string; message: string };

export class WorkoutValidationError extends Error {
  readonly issues: WorkoutValidationIssue[];

  constructor(path: string, message: string) {
    super(`Invalid workout payload at ${path}: ${message}`);
    this.name = "WorkoutValidationError";
    this.issues = [{ path, message }];
  }
}

export type NormalisedWorkoutSet = {
  setId: string;
  sessionId: string;
  exercise: string;
  setNoSession: number;
  setNoExercise: number;
  weightKgReported: number | null;
  reps: number | null;
  timeSeconds: number | null;
  distanceM: number | null;
  restSeconds: number | null;
  effortRaw: string | null;
  setTypeManual: string | null;
  loadBasisManual: string | null;
  pain010Manual: number | null;
  venueManual: string | null;
  coachNote: string | null;
  sourceFile: string;
  reportedLoadXRepsKg: number;
};

export type NormalisedWorkout = {
  sessionId: string;
  source: string;
  sessionIntent: "normal" | "deload" | "test";
  trainingBlockId: string | null;
  trainingPhaseId: string | null;
  sessionTitle: string;
  sessionType: string;
  startedAt: string;
  startedAtUtc: string;
  localDate: string;
  endedAt: string;
  timePrecision: "minute" | "exact";
  durationSeconds: number;
  burnedCaloriesKcalReported: number | null;
  totalTvlKgReported: number | null;
  effortRaw: string | null;
  venueManual: string | null;
  notesManual: string | null;
  activeCaloriesKcal: number | null;
  totalCaloriesKcal: number | null;
  elevationMetres: number | null;
  floorsClimbed: number | null;
  averageRpm: number | null;
  averageHeartRateBpm: number | null;
  zone1Seconds: number | null;
  zone2Seconds: number | null;
  zone3Seconds: number | null;
  zone4Seconds: number | null;
  zone5Seconds: number | null;
  shoulderPainPre010Manual: number | null;
  shoulderPainPost010Manual: number | null;
  fatigueRpe010Manual: number | null;
  sets: NormalisedWorkoutSet[];
};

function invalid(path: string, message: string): never {
  throw new WorkoutValidationError(path, message);
}

function objectValue(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(path, "must be an object");
  }
  return value as JsonObject;
}

function assertKnownFields(
  value: JsonObject,
  allowed: readonly string[],
  path: string,
) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    invalid(path, `unknown field(s): ${unknown.join(", ")}`);
  }
}

function requiredText(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    invalid(path, "must be a non-empty string");
  }
  return value.trim();
}

function optionalText(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") invalid(path, "must be a string or null");
  return value.trim() || null;
}

function optionalTrainingPhaseId(value: unknown): string | null {
  const id = optionalText(value, "trainingPhaseId");
  if (id !== null && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
    invalid("trainingPhaseId", "must be a lowercase stable identifier");
  }
  return id;
}

function sessionIntent(value: unknown): "normal" | "deload" | "test" {
  if (value === undefined) return "normal";
  if (value !== "normal" && value !== "deload" && value !== "test") {
    invalid("sessionIntent", "must be normal, deload, or test");
  }
  return value;
}

function strictNumber(
  value: unknown,
  path: string,
  options: NumberOptions = {},
): number | null {
  if (value === null || value === undefined) {
    if (options.optional) return null;
    invalid(path, "is required and must be a number");
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(path, "must be a finite JSON number");
  }
  if (options.integer && !Number.isInteger(value)) {
    invalid(path, "must be an integer");
  }
  if (options.min !== undefined && value < options.min) {
    invalid(path, `must be at least ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    invalid(path, `must be at most ${options.max}`);
  }
  return value;
}

export function canonicalWorkoutTime(
  value: unknown,
  durationSeconds: number,
  timezone: string,
) {
  if (!isIsoTimestamp(value)) {
    invalid("startedAt", "must be an ISO timestamp with timezone");
  }
  const start = new Date(value);
  const startedAt = timestampInTimeZone(start, timezone);
  return {
    startedAt,
    startedAtUtc: start.toISOString(),
    localDate: startedAt.slice(0, 10),
    endedAt: timestampInTimeZone(
      new Date(start.getTime() + durationSeconds * 1000),
      timezone,
    ),
  };
}

function normaliseSets(rawSets: unknown, sessionId: string) {
  if (!Array.isArray(rawSets)) invalid("sets", "is required and must be an array");

  const exerciseOrdinals = new Map<string, number>();
  const setIds = new Set<string>();

  return rawSets.map((rawSet, index) => {
    const path = `sets[${index}]`;
    const set = objectValue(rawSet, path);
    assertKnownFields(set, WORKOUT_SET_INPUT_FIELDS, path);
    const exercise = requiredText(set.exercise, `${path}.exercise`);
    const setNoSession =
      strictNumber(set.setNoSession ?? index + 1, `${path}.setNoSession`, {
        min: 1,
        integer: true,
      }) ?? index + 1;
    if (setNoSession !== index + 1) {
      invalid(`${path}.setNoSession`, `must equal ${index + 1}`);
    }
    const nextExerciseOrdinal = (exerciseOrdinals.get(exercise) ?? 0) + 1;
    const setNoExercise =
      strictNumber(
        set.setNoExercise ?? nextExerciseOrdinal,
        `${path}.setNoExercise`,
        { min: 1, integer: true },
      ) ?? nextExerciseOrdinal;
    if (setNoExercise !== nextExerciseOrdinal) {
      invalid(`${path}.setNoExercise`, `must equal ${nextExerciseOrdinal}`);
    }
    exerciseOrdinals.set(exercise, nextExerciseOrdinal);

    const setId =
      optionalText(set.setId, `${path}.setId`) ||
      `${sessionId}|SET|${setNoSession}`;
    if (setIds.has(setId)) invalid(`${path}.setId`, "must be unique");
    setIds.add(setId);
    const weight = strictNumber(
      set.weightKgReported,
      `${path}.weightKgReported`,
      { min: 0, max: 1000, optional: true },
    );
    const reps = strictNumber(set.reps, `${path}.reps`, {
      min: 0,
      max: 1000,
      optional: true,
      integer: true,
    });

    return {
      setId,
      sessionId,
      exercise,
      setNoSession,
      setNoExercise,
      weightKgReported: weight,
      reps,
      timeSeconds: strictNumber(set.timeSeconds, `${path}.timeSeconds`, {
        min: 0,
        optional: true,
      }),
      distanceM: strictNumber(set.distanceM, `${path}.distanceM`, {
        min: 0,
        optional: true,
      }),
      restSeconds: strictNumber(set.restSeconds, `${path}.restSeconds`, {
        min: 0,
        optional: true,
      }),
      effortRaw: optionalText(set.effortRaw, `${path}.effortRaw`),
      setTypeManual: optionalText(set.setTypeManual, `${path}.setTypeManual`),
      loadBasisManual: optionalText(
        set.loadBasisManual,
        `${path}.loadBasisManual`,
      ),
      pain010Manual: strictNumber(set.pain010Manual, `${path}.pain010Manual`, {
        min: 0,
        max: 10,
        optional: true,
      }),
      venueManual: optionalText(set.venueManual, `${path}.venueManual`),
      coachNote: optionalText(set.coachNote, `${path}.coachNote`),
      sourceFile:
        optionalText(set.sourceFile, `${path}.sourceFile`) ||
        "Open Fitness WebApp",
      reportedLoadXRepsKg:
        Math.round((weight ?? 0) * (reps ?? 0) * 1000) / 1000,
    } satisfies NormalisedWorkoutSet;
  });
}

export function normaliseWorkoutPayload(
  value: unknown,
  options: { idempotencyKey?: string; timezone?: string } = {},
): NormalisedWorkout {
  const payload = objectValue(value, "workout");
  assertKnownFields(payload, WORKOUT_INPUT_FIELDS, "workout");
  const durationSeconds =
    strictNumber(payload.durationSeconds, "durationSeconds", {
      min: 0,
      max: 86_400,
      integer: true,
    }) ?? 0;
  const time = canonicalWorkoutTime(
    payload.startedAt,
    durationSeconds,
    options.timezone ?? DEFAULT_TIMEZONE,
  );
  const idempotencyKey = options.idempotencyKey?.trim() || "local-validation";
  const sessionId =
    optionalText(payload.sessionId, "sessionId") ||
    `WEB|${time.startedAtUtc}|${idempotencyKey}`;
  const timePrecision = payload.timePrecision ?? "minute";
  if (timePrecision !== "minute" && timePrecision !== "exact") {
    invalid("timePrecision", "must be minute or exact");
  }
  const suppliedEndedAt = optionalText(payload.endedAt, "endedAt");
  if (
    suppliedEndedAt !== null &&
    Date.parse(suppliedEndedAt) !== Date.parse(time.endedAt)
  ) {
    invalid("endedAt", "must equal startedAt plus durationSeconds");
  }
  const sets = normaliseSets(payload.sets, sessionId);
  const suppliedSetCount = strictNumber(
    payload.totalSetsReported,
    "totalSetsReported",
    { min: 0, optional: true, integer: true },
  );
  if (suppliedSetCount !== null && suppliedSetCount !== sets.length) {
    invalid("totalSetsReported", `must equal canonical set count ${sets.length}`);
  }

  return {
    sessionId,
    source: optionalText(payload.source, "source") || "Open Fitness WebApp",
    sessionIntent: sessionIntent(payload.sessionIntent),
    trainingBlockId: optionalText(payload.trainingBlockId, "trainingBlockId"),
    trainingPhaseId: optionalTrainingPhaseId(payload.trainingPhaseId),
    sessionTitle: requiredText(payload.title, "title"),
    sessionType: requiredText(payload.type, "type"),
    ...time,
    timePrecision,
    durationSeconds,
    burnedCaloriesKcalReported: strictNumber(
      payload.burnedCaloriesKcalReported,
      "burnedCaloriesKcalReported",
      { min: 0, optional: true },
    ),
    totalTvlKgReported: strictNumber(
      payload.totalTvlKgReported,
      "totalTvlKgReported",
      { min: 0, optional: true },
    ),
    effortRaw: optionalText(payload.effortRaw, "effortRaw"),
    venueManual: optionalText(payload.venueManual, "venueManual"),
    notesManual: optionalText(payload.notesManual, "notesManual"),
    activeCaloriesKcal: strictNumber(
      payload.activeCaloriesKcal,
      "activeCaloriesKcal",
      { min: 0, optional: true },
    ),
    totalCaloriesKcal: strictNumber(
      payload.totalCaloriesKcal,
      "totalCaloriesKcal",
      { min: 0, optional: true },
    ),
    elevationMetres: strictNumber(payload.elevationMetres, "elevationMetres", {
      min: 0,
      optional: true,
    }),
    floorsClimbed: strictNumber(payload.floorsClimbed, "floorsClimbed", {
      min: 0,
      optional: true,
      integer: true,
    }),
    averageRpm: strictNumber(payload.averageRpm, "averageRpm", {
      min: 0,
      optional: true,
    }),
    averageHeartRateBpm: strictNumber(
      payload.averageHeartRateBpm,
      "averageHeartRateBpm",
      { min: 0, max: 250, optional: true },
    ),
    zone1Seconds: strictNumber(payload.zone1Seconds, "zone1Seconds", {
      min: 0,
      optional: true,
      integer: true,
    }),
    zone2Seconds: strictNumber(payload.zone2Seconds, "zone2Seconds", {
      min: 0,
      optional: true,
      integer: true,
    }),
    zone3Seconds: strictNumber(payload.zone3Seconds, "zone3Seconds", {
      min: 0,
      optional: true,
      integer: true,
    }),
    zone4Seconds: strictNumber(payload.zone4Seconds, "zone4Seconds", {
      min: 0,
      optional: true,
      integer: true,
    }),
    zone5Seconds: strictNumber(payload.zone5Seconds, "zone5Seconds", {
      min: 0,
      optional: true,
      integer: true,
    }),
    shoulderPainPre010Manual: strictNumber(
      payload.shoulderPainPre010Manual,
      "shoulderPainPre010Manual",
      { min: 0, max: 10, optional: true },
    ),
    shoulderPainPost010Manual: strictNumber(
      payload.shoulderPainPost010Manual,
      "shoulderPainPost010Manual",
      { min: 0, max: 10, optional: true },
    ),
    fatigueRpe010Manual: strictNumber(
      payload.fatigueRpe010Manual,
      "fatigueRpe010Manual",
      { min: 0, max: 10, optional: true },
    ),
    sets,
  };
}

export const workoutWriteContract = {
  version: WORKOUT_CONTRACT_VERSION,
  timezone: "profile.timezone",
  identity: "canonical UTC instant among active sessions",
  requiredFields: ["title", "type", "startedAt", "durationSeconds", "sets"],
  allowedFields: WORKOUT_INPUT_FIELDS,
  allowedSetFields: WORKOUT_SET_INPUT_FIELDS,
  timePrecision: ["minute", "exact"],
  mutation: {
    create: "POST",
    validateOnly: "POST ?validateOnly=1 (same body and idempotency key; no write)",
    voidOrRestore: "PATCH",
    readBack: "GET ?sessionId=... returns effective names and appliedCorrections",
  },
  rules: [
    "Unknown fields and wrong JSON types are rejected with field paths.",
    "Every POST requires x-idempotency-key.",
    "Equal instants with different timezone text are duplicates.",
    "Voided sessions are excluded from analysis and can be restored.",
    "Append-only workout corrections preserve source rows and overlay exact reads.",
    "Optional endedAt, totalSetsReported, and trainingBlockId are consistency assertions and must match canonical values.",
  ],
  corrections: {
    targetFields: {
      workout_session: ["session_title", "training_phase_id"],
      workout_set: [
        "exercise",
        "reps",
        "weight_kg_reported",
        "effort_raw",
      ],
    },
    nullableFields: ["reps", "weight_kg_reported", "effort_raw"],
    derivedMetrics: ["reportedLoadXRepsKg"],
    optimisticOriginalValue: true,
    rawRowsPreserved: true,
  },
} as const;
