import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  auditLog,
  corrections,
  operatingConstraints,
  profile,
  workoutSessions,
  workoutSets,
} from "@/db/schema";
import {
  getApiActor,
  routeError,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { apiError } from "@/lib/api-error";
import { findIdempotentReplay } from "@/lib/idempotency";
import {
  isDateOnly,
  isIsoTimestamp,
  payloadSha256,
  requiredText,
} from "@/lib/record-utils";
import {
  effectiveWorkoutRecords,
  WORKOUT_CORRECTION_FIELDS,
  WORKOUT_CORRECTION_TARGETS,
  type WorkoutCorrection,
  type WorkoutReadDb,
} from "@/lib/workout-corrections";
import {
  effectiveOperatingConstraints,
  normaliseOperatingConstraintStatus,
  OPERATING_CONSTRAINT_CORRECTION_FIELD,
  OPERATING_CONSTRAINT_CORRECTION_SCOPE,
  OPERATING_CONSTRAINT_STATUSES,
} from "@/lib/operating-constraint-corrections";
import { parseCycle } from "@/lib/training-cycle";

export const dynamic = "force-dynamic";

type CorrectionInput = {
  correctionId?: string;
  effectiveDate?: string;
  targetScope?: string;
  targetKey?: string;
  fieldName?: string;
  originalValue?: unknown;
  correctedValue?: unknown;
  reason?: string;
  source?: string;
  recordedAt?: string;
};

type WorkoutScope = keyof typeof WORKOUT_CORRECTION_TARGETS;

type WorkoutField =
  | "session_title"
  | "training_phase_id"
  | "exercise"
  | "reps"
  | "weight_kg_reported"
  | "effort_raw";

type CorrectionValue = string | number | null;

type WorkoutFieldSpec = {
  scope: WorkoutScope;
  property: "sessionTitle" | "trainingPhaseId" | "exercise" | "reps" | "weightKgReported" | "effortRaw";
  kind: "text" | "phase" | "integer" | "number";
  nullable: boolean;
  min?: number;
  max?: number;
};

const WORKOUT_FIELD_SPECS: Record<WorkoutField, WorkoutFieldSpec> = {
  session_title: {
    scope: "workout_session",
    property: "sessionTitle",
    kind: "text",
    nullable: false,
  },
  training_phase_id: {
    scope: "workout_session",
    property: "trainingPhaseId",
    kind: "phase",
    nullable: true,
  },
  exercise: {
    scope: "workout_set",
    property: "exercise",
    kind: "text",
    nullable: false,
  },
  reps: {
    scope: "workout_set",
    property: "reps",
    kind: "integer",
    nullable: true,
    min: 0,
    max: 1000,
  },
  weight_kg_reported: {
    scope: "workout_set",
    property: "weightKgReported",
    kind: "number",
    nullable: true,
    min: 0,
    max: 1000,
  },
  effort_raw: {
    scope: "workout_set",
    property: "effortRaw",
    kind: "text",
    nullable: true,
  },
};

type WorkoutTargetState = {
  targetLocalDate: string | null;
  sourceValue: CorrectionValue;
  effectiveValue: CorrectionValue;
  appliedCorrection: WorkoutCorrection | null;
};

type OperatingConstraintTargetState = {
  targetEffectiveDate: string;
  sourceValue: CorrectionValue;
  effectiveValue: CorrectionValue;
  appliedCorrection: WorkoutCorrection | null;
};

function isWorkoutField(value: string): value is WorkoutField {
  return Object.hasOwn(WORKOUT_FIELD_SPECS, value);
}

function fieldSpec(scope: WorkoutScope, fieldName: string) {
  if (!isWorkoutField(fieldName)) return null;
  const spec = WORKOUT_FIELD_SPECS[fieldName];
  return spec.scope === scope ? spec : null;
}

function stablePhaseId(value: string) {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

function normaliseWorkoutCorrectionValue(
  spec: WorkoutFieldSpec,
  value: unknown,
  role: "original" | "corrected",
): CorrectionValue {
  if (value === null) {
    if (spec.kind === "phase" && role === "corrected") {
      throw new CorrectionValueError(
        "training_phase_id corrections can attach or reassign a phase but cannot detach one",
        "WORKOUT_CORRECTION_PHASE_DETACH_UNSUPPORTED",
      );
    }
    if (spec.nullable) return null;
    throw new CorrectionValueError(
      `${role}Value cannot be null for ${spec.property}`,
      "WORKOUT_CORRECTION_INVALID_VALUE",
    );
  }
  if (spec.kind === "text") {
    if (typeof value !== "string" || !value.trim()) {
      throw new CorrectionValueError(
        `${role}Value must be a non-empty string for ${spec.property}`,
        "WORKOUT_CORRECTION_INVALID_VALUE",
      );
    }
    return value.trim();
  }
  if (spec.kind === "phase") {
    if (typeof value !== "string" || !stablePhaseId(value.trim())) {
      throw new CorrectionValueError(
        `${role}Value must be a lowercase stable phase identifier or null`,
        "WORKOUT_CORRECTION_INVALID_VALUE",
      );
    }
    return value.trim();
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CorrectionValueError(
      `${role}Value must be a finite JSON number or null`,
      "WORKOUT_CORRECTION_INVALID_VALUE",
    );
  }
  if (spec.kind === "integer" && !Number.isInteger(value)) {
    throw new CorrectionValueError(
      `${role}Value must be an integer`,
      "WORKOUT_CORRECTION_INVALID_VALUE",
    );
  }
  if (
    (spec.min !== undefined && value < spec.min) ||
    (spec.max !== undefined && value > spec.max)
  ) {
    throw new CorrectionValueError(
      `${role}Value is outside the supported range for ${spec.property}`,
      "WORKOUT_CORRECTION_VALUE_OUT_OF_RANGE",
    );
  }
  return value;
}

function serialiseCorrectionValue(value: CorrectionValue) {
  return value === null ? null : String(value);
}

function correctionValuesEqual(left: CorrectionValue, right: CorrectionValue) {
  return left === right;
}

function parsedCorrectionInstant(value: string) {
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
}

class CorrectionValueError extends Error {
  readonly errorCode: string;

  constructor(message: string, errorCode: string) {
    super(message);
    this.errorCode = errorCode;
  }
}

function isWorkoutScope(value: string): value is WorkoutScope {
  return Object.hasOwn(WORKOUT_CORRECTION_TARGETS, value);
}

function workoutValueFor(
  row: Record<string, unknown>,
  spec: WorkoutFieldSpec,
): CorrectionValue {
  const value = row[spec.property];
  if (value === undefined || value === null) return null;
  if (spec.kind === "integer" || spec.kind === "number") {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  return typeof value === "string" ? value : null;
}

async function workoutTargetState(
  db: WorkoutReadDb,
  targetScope: WorkoutScope,
  targetKey: string,
  spec: WorkoutFieldSpec,
): Promise<WorkoutTargetState | "missing" | "voided"> {
  if (targetScope === "workout_session") {
    const rows = await db
      .select({
        sessionId: workoutSessions.sessionId,
        sessionTitle: workoutSessions.sessionTitle,
        trainingPhaseId: workoutSessions.trainingPhaseId,
        localDate: workoutSessions.localDate,
        voidedAt: workoutSessions.voidedAt,
      })
      .from(workoutSessions)
      .where(eq(workoutSessions.sessionId, targetKey))
      .limit(1);
    const source = rows[0];
    if (!source) return "missing";
    if (source.voidedAt) return "voided";
    const projected = await effectiveWorkoutRecords(
      { sessions: [source] },
      db,
    );
    return {
      targetLocalDate: source.localDate,
      sourceValue: workoutValueFor(source, spec),
      effectiveValue: workoutValueFor(
        projected.sessions[0] as unknown as Record<string, unknown>,
        spec,
      ),
      appliedCorrection:
        projected.appliedCorrections.find(
          (correction) => correction.fieldName === specForFieldName(spec),
        ) ?? null,
    };
  }

  const rows = await db
    .select({
      setId: workoutSets.setId,
      exercise: workoutSets.exercise,
      reps: workoutSets.reps,
      weightKgReported: workoutSets.weightKgReported,
      effortRaw: workoutSets.effortRaw,
      localDate: workoutSessions.localDate,
      voidedAt: workoutSessions.voidedAt,
    })
    .from(workoutSets)
    .innerJoin(
      workoutSessions,
      eq(workoutSets.sessionId, workoutSessions.sessionId),
    )
    .where(eq(workoutSets.setId, targetKey))
    .limit(1);
  const source = rows[0];
  if (!source) return "missing";
  if (source.voidedAt) return "voided";
  const projected = await effectiveWorkoutRecords({ sets: [source] }, db);
  return {
    targetLocalDate: source.localDate,
    sourceValue: workoutValueFor(source, spec),
    effectiveValue: workoutValueFor(
      projected.sets[0] as unknown as Record<string, unknown>,
      spec,
    ),
    appliedCorrection:
      projected.appliedCorrections.find(
        (correction) => correction.fieldName === specForFieldName(spec),
      ) ?? null,
  };
}

async function operatingConstraintTargetState(
  db: WorkoutReadDb,
  targetKey: string,
  asOfDate: string,
): Promise<OperatingConstraintTargetState | "missing"> {
  const rows = await db
    .select()
    .from(operatingConstraints)
    .where(eq(operatingConstraints.constraintId, targetKey))
    .limit(1);
  const source = rows[0];
  if (!source) return "missing";
  const projected = await effectiveOperatingConstraints(
    [source],
    asOfDate,
    db,
  );
  const projectedStatus = projected.constraints[0]?.status ?? source.status;
  return {
    targetEffectiveDate: source.effectiveDate,
    sourceValue: source.status,
    effectiveValue:
      normaliseOperatingConstraintStatus(projectedStatus) ??
      projectedStatus.trim(),
    appliedCorrection: projected.appliedCorrections[0] ?? null,
  };
}

function specForFieldName(spec: WorkoutFieldSpec) {
  return Object.entries(WORKOUT_FIELD_SPECS).find(
    ([, candidate]) => candidate === spec,
  )?.[0];
}

export async function POST(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const idempotencyKey = request.headers.get("x-idempotency-key")?.trim();
    if (!idempotencyKey || idempotencyKey.length > 200) {
      return apiError(
        "CORRECTION_IDEMPOTENCY_REQUIRED",
        400,
        { field: "x-idempotency-key", maximumLength: 200 },
        "Correction idempotency key is required",
      );
    }

    let rawPayload: unknown;
    try {
      rawPayload = await request.json();
    } catch {
      return apiError(
        "INVALID_CORRECTION_PAYLOAD",
        400,
        { expectedType: "object" },
        "Invalid correction payload",
      );
    }
    if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
      return apiError(
        "INVALID_CORRECTION_PAYLOAD",
        400,
        { expectedType: "object" },
        "Invalid correction payload",
      );
    }
    const unknownFields = Object.keys(rawPayload).filter(
      (key) =>
        ![
          "correctionId",
          "effectiveDate",
          "targetScope",
          "targetKey",
          "fieldName",
          "originalValue",
          "correctedValue",
          "reason",
          "source",
          "recordedAt",
        ].includes(key),
    );
    if (unknownFields.length > 0) {
      return apiError(
        "UNKNOWN_CORRECTION_FIELD",
        400,
        { fields: unknownFields },
        "Unknown correction field",
      );
    }
    const payload = rawPayload as CorrectionInput;
    if (!isDateOnly(payload.effectiveDate)) {
      return apiError(
        "INVALID_CORRECTION_EFFECTIVE_DATE",
        400,
        { field: "effectiveDate" },
        "Invalid correction effective date",
      );
    }
    const effectiveDate = payload.effectiveDate;
    if (
      payload.recordedAt !== undefined &&
      !isIsoTimestamp(payload.recordedAt)
    ) {
      return apiError(
        "INVALID_CORRECTION_RECORDED_AT",
        400,
        { field: "recordedAt" },
        "Invalid correction timestamp",
      );
    }

    let targetScope: string;
    let targetKey: string;
    let fieldName: string;
    let reason: string;
    let source: string;
    let providedCorrectionId: string | null;
    try {
      targetScope = requiredText(payload.targetScope, "targetScope");
      targetKey = requiredText(payload.targetKey, "targetKey");
      fieldName = requiredText(payload.fieldName, "fieldName");
      reason = requiredText(payload.reason, "reason");
      source = requiredText(payload.source, "source");
      providedCorrectionId =
        payload.correctionId === undefined
          ? null
          : requiredText(payload.correctionId, "correctionId");
    } catch {
      return apiError(
        "INVALID_CORRECTION_FIELD",
        400,
        {},
        "Invalid correction field",
      );
    }
    const db = getDb();
    const workoutScope = isWorkoutScope(targetScope) ? targetScope : null;
    const operatingConstraintScope =
      targetScope === OPERATING_CONSTRAINT_CORRECTION_SCOPE;
    const spec = workoutScope ? fieldSpec(workoutScope, fieldName) : null;
    if (workoutScope && !spec) {
      return apiError(
        "UNSUPPORTED_WORKOUT_CORRECTION_FIELD",
        400,
        {
          targetScope: workoutScope,
          fieldName,
          supportedFields: WORKOUT_CORRECTION_FIELDS[workoutScope],
        },
        "Unsupported workout correction field",
      );
    }
    if (
      operatingConstraintScope &&
      fieldName !== OPERATING_CONSTRAINT_CORRECTION_FIELD
    ) {
      return apiError(
        "UNSUPPORTED_OPERATING_CONSTRAINT_CORRECTION_FIELD",
        400,
        {
          targetScope: OPERATING_CONSTRAINT_CORRECTION_SCOPE,
          fieldName,
          supportedFields: [OPERATING_CONSTRAINT_CORRECTION_FIELD],
        },
        "Unsupported operating constraint correction field",
      );
    }
    if (workoutScope && payload.correctedValue === undefined) {
      return apiError(
        "WORKOUT_CORRECTION_VALUE_REQUIRED",
        400,
        { field: "correctedValue" },
        "Workout correction value is required",
      );
    }
    if (workoutScope && payload.originalValue === undefined) {
      return apiError(
        "WORKOUT_CORRECTION_ORIGINAL_REQUIRED",
        400,
        { field: "originalValue" },
        "Workout correction original value is required",
      );
    }
    if (
      operatingConstraintScope &&
      (payload.originalValue === undefined ||
        payload.correctedValue === undefined)
    ) {
      return apiError(
        "OPERATING_CONSTRAINT_CORRECTION_VALUES_REQUIRED",
        400,
        { fields: ["originalValue", "correctedValue"] },
        "Operating constraint correction values are required",
      );
    }
    let originalValue: CorrectionValue | null = null;
    let correctedValue: CorrectionValue | null = null;
    // Range failures use the stable WORKOUT_CORRECTION_VALUE_OUT_OF_RANGE code.
    if (spec) {
      try {
        originalValue = normaliseWorkoutCorrectionValue(
          spec,
          payload.originalValue,
          "original",
        );
        correctedValue = normaliseWorkoutCorrectionValue(
          spec,
          payload.correctedValue,
          "corrected",
        );
      } catch (error) {
        if (error instanceof CorrectionValueError) {
          return apiError(
            error.errorCode,
            400,
            {},
            "Invalid workout correction value",
          );
        }
        throw error;
      }
    } else if (operatingConstraintScope) {
      originalValue =
        normaliseOperatingConstraintStatus(payload.originalValue) ??
        (typeof payload.originalValue === "string" &&
        payload.originalValue.trim()
          ? payload.originalValue.trim()
          : null);
      correctedValue = normaliseOperatingConstraintStatus(
        payload.correctedValue,
      );
      if (!originalValue) {
        return apiError(
          "INVALID_OPERATING_CONSTRAINT_ORIGINAL",
          400,
          { field: "originalValue" },
          "Invalid operating constraint original value",
        );
      }
      if (!correctedValue) {
        return apiError(
          "INVALID_OPERATING_CONSTRAINT_STATUS",
          400,
          { allowedStatuses: OPERATING_CONSTRAINT_STATUSES },
          "Invalid operating constraint status",
        );
      }
    } else {
      if (
        payload.correctedValue !== undefined &&
        payload.correctedValue !== null &&
        typeof payload.correctedValue !== "string"
      ) {
        return apiError(
          "INVALID_CORRECTION_VALUE",
          400,
          { field: "correctedValue", expectedTypes: ["string", "null"] },
          "Invalid correction value",
        );
      }
      if (
        payload.originalValue !== undefined &&
        payload.originalValue !== null &&
        typeof payload.originalValue !== "string"
      ) {
        return apiError(
          "INVALID_CORRECTION_ORIGINAL",
          400,
          { field: "originalValue", expectedTypes: ["string", "null"] },
          "Invalid correction original value",
        );
      }
      originalValue = (payload.originalValue as string | null | undefined) ?? null;
      // Generic corrections retain the existing nullable semantics:
      // correctedValue: payload.correctedValue ?? null.
      correctedValue = (payload.correctedValue as string | null | undefined) ?? null;
    }
    const recordedAt = payload.recordedAt
      ? new Date(payload.recordedAt).toISOString()
      : new Date().toISOString();
    const digest = await payloadSha256(payload);
    const generatedIdDigest = await payloadSha256(idempotencyKey);
    const id =
      providedCorrectionId ||
      `CORRECTION|${effectiveDate}|${generatedIdDigest}`;
    type WriteResult =
      | { kind: "created"; correctionId: string }
      | { kind: "replay"; correctionId: string }
      | { kind: "missing" }
      | { kind: "voided" }
      | { kind: "dateUnavailable" }
      | { kind: "dateMismatch"; targetDate: string | null }
      | { kind: "dateBeforeTarget"; targetDate: string }
      | { kind: "invalidPhase" }
      | { kind: "stale"; currentValue: CorrectionValue }
      | { kind: "recordedAtStale"; currentRecordedAt: string };
    let writeResult: WriteResult;
    try {
      writeResult = await db.transaction(async (tx): Promise<WriteResult> => {
        const replayedId = await findIdempotentReplay(
          idempotencyKey,
          "correction",
          digest,
          tx,
        );
        if (replayedId) {
          return { kind: "replay", correctionId: replayedId };
        }

        if (spec?.kind === "phase" && correctedValue !== null) {
          const profileRows = await tx
            .select({
              trainingCycle: profile.trainingCycle,
              trainingCycleConfig: profile.trainingCycleConfig,
            })
            .from(profile)
            .limit(1);
          const currentProfile = profileRows[0];
          const phases = parseCycle(
            currentProfile?.trainingCycle,
            currentProfile?.trainingCycleConfig,
          );
          if (!phases.some((phase) => phase.id === correctedValue)) {
            return { kind: "invalidPhase" };
          }
        }

        const targetState = workoutScope
          ? await workoutTargetState(tx, workoutScope, targetKey, spec!)
          : operatingConstraintScope
            ? await operatingConstraintTargetState(
                tx,
                targetKey,
                effectiveDate,
              )
            : null;
        if (targetState === "missing") return { kind: "missing" };
        if (targetState === "voided") return { kind: "voided" };
        if (
          targetState &&
          "targetLocalDate" in targetState &&
          (!targetState.targetLocalDate ||
            !isDateOnly(targetState.targetLocalDate))
        ) {
          return { kind: "dateUnavailable" };
        }
        if (
          targetState &&
          "targetLocalDate" in targetState &&
          targetState.targetLocalDate !== effectiveDate
        ) {
          return {
            kind: "dateMismatch",
            targetDate: targetState.targetLocalDate,
          };
        }
        if (
          targetState &&
          "targetEffectiveDate" in targetState &&
          effectiveDate < targetState.targetEffectiveDate
        ) {
          return {
            kind: "dateBeforeTarget",
            targetDate: targetState.targetEffectiveDate,
          };
        }
        if (
          targetState &&
          targetState.appliedCorrection
        ) {
          const currentInstant = parsedCorrectionInstant(
            targetState.appliedCorrection.recordedAt,
          );
          const requestedInstant = parsedCorrectionInstant(recordedAt);
          if (
            currentInstant !== null &&
            requestedInstant !== null &&
            requestedInstant <= currentInstant
          ) {
            return {
              kind: "recordedAtStale",
              currentRecordedAt: targetState.appliedCorrection.recordedAt,
            };
          }
        }
        if (
          targetState &&
          !correctionValuesEqual(originalValue, targetState.effectiveValue)
        ) {
          return {
            kind: "stale",
            currentValue: targetState.effectiveValue,
          };
        }

        await tx.insert(corrections).values({
          correctionId: id,
          effectiveDate,
          targetScope,
          targetKey,
          fieldName,
          originalValue: targetState
            ? serialiseCorrectionValue(targetState.effectiveValue)
            : serialiseCorrectionValue(originalValue),
          correctedValue: serialiseCorrectionValue(correctedValue),
          reason,
          source,
          recordedAt,
        });
        await tx.insert(auditLog).values({
          requestId: idempotencyKey,
          actor: actor.id,
          operation: "insert",
          entityType: "correction",
          entityId: id,
          payloadSha256: digest,
        });
        return { kind: "created", correctionId: id };
      });
    } catch (error) {
      const racedReplay = await findIdempotentReplay(
        idempotencyKey,
        "correction",
        digest,
      );
      if (!racedReplay) throw error;
      writeResult = { kind: "replay", correctionId: racedReplay };
    }

    if (writeResult.kind === "missing") {
      return apiError(
        operatingConstraintScope
          ? "OPERATING_CONSTRAINT_TARGET_NOT_FOUND"
          : "WORKOUT_CORRECTION_TARGET_NOT_FOUND",
        404,
        { targetScope, targetKey },
        "Correction target not found",
      );
    }
    if (writeResult.kind === "voided") {
      return apiError(
        "WORKOUT_CORRECTION_TARGET_VOIDED",
        409,
        { targetKey },
        "Workout correction target is voided",
      );
    }
    if (writeResult.kind === "dateUnavailable") {
      return apiError(
        "WORKOUT_CORRECTION_TARGET_DATE_UNAVAILABLE",
        400,
        { targetKey },
        "Workout correction target date is unavailable",
      );
    }
    if (writeResult.kind === "dateMismatch") {
      return apiError(
        "WORKOUT_CORRECTION_DATE_MISMATCH",
        400,
        { targetDate: writeResult.targetDate },
        "Workout correction date mismatch",
      );
    }
    if (writeResult.kind === "dateBeforeTarget") {
      return apiError(
        "OPERATING_CONSTRAINT_DATE_BEFORE_TARGET",
        400,
        { targetDate: writeResult.targetDate },
        "Operating constraint correction date is too early",
      );
    }
    if (writeResult.kind === "invalidPhase") {
      return apiError(
        "WORKOUT_CORRECTION_INVALID_PHASE",
        400,
        { field: "correctedValue" },
        "Invalid workout correction phase",
      );
    }
    if (writeResult.kind === "stale") {
      return apiError(
        operatingConstraintScope
          ? "OPERATING_CONSTRAINT_STALE_ORIGINAL"
          : "WORKOUT_CORRECTION_STALE_ORIGINAL",
        409,
        { currentValue: writeResult.currentValue },
        "Correction target changed",
      );
    }
    if (writeResult.kind === "recordedAtStale") {
      return apiError(
        operatingConstraintScope
          ? "OPERATING_CONSTRAINT_RECORDED_AT_STALE"
          : "WORKOUT_CORRECTION_RECORDED_AT_STALE",
        409,
        { currentRecordedAt: writeResult.currentRecordedAt },
        "Correction timestamp is stale",
      );
    }

    const storedState = workoutScope
      ? await workoutTargetState(db, workoutScope, targetKey, spec!)
      : operatingConstraintScope
        ? await operatingConstraintTargetState(
            db,
            targetKey,
            effectiveDate,
          )
        : null;
    return Response.json(
      {
        correctionId: writeResult.correctionId,
        requestId: idempotencyKey,
        replay: writeResult.kind === "replay",
        ...(storedState && storedState !== "missing" && storedState !== "voided"
          ? { target: storedState }
          : {}),
      },
      { status: writeResult.kind === "replay" ? 200 : 201 },
    );
  } catch (error) {
    return routeError(error);
  }
}
