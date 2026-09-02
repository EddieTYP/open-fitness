import {
  normaliseTrainingCycleConfig,
  type TrainingCycleConfig,
  type TrainingRoutineSlotConfig,
} from "./training-cycle.ts";

type JsonObject = Record<string, unknown>;

export type TrainingTemplateSession = {
  sessionId: string;
  trainingPhaseId: string | null;
  sessionTitle: string;
  startedAt: string;
  startedAtUtc?: string | null;
  localDate: string | null;
};

export type TrainingTemplateSet = {
  sessionId: string;
  exercise: string;
  setNoSession: number;
  weightKgReported: number | null;
  reps: number | null;
  setTypeManual: string | null;
};

export type TrainingTemplateProposalSource = {
  phaseId: string;
  status: "kept_existing" | "derived_history" | "no_history";
  sessionId?: string;
  sessionTitle?: string;
  localDate?: string | null;
};

export type TrainingTemplateProposal = {
  template: TrainingCycleConfig;
  sources: TrainingTemplateProposalSource[];
  warnings: TrainingTemplateProposalWarning[];
};

export type TrainingTemplateProposalWarning = {
  phaseId: string;
  code:
    | "history_exercise_name_unsupported"
    | "history_routine_items_truncated";
  count: number;
};

export type TrainingTemplateMutation = {
  expectedUpdatedAt: string;
  template: TrainingCycleConfig;
};

export class TrainingTemplateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrainingTemplateValidationError";
  }
}

function objectValue(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TrainingTemplateValidationError(`${path} must be an object`);
  }
  return value as JsonObject;
}

function assertKnownFields(
  value: JsonObject,
  allowed: readonly string[],
  path: string,
) {
  const allowedFields = new Set(allowed);
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      throw new TrainingTemplateValidationError(
        `${path}.${field} is not supported`,
      );
    }
  }
}

export function normaliseTrainingTemplateMutation(
  value: unknown,
): TrainingTemplateMutation {
  const payload = objectValue(value, "payload");
  assertKnownFields(payload, ["expectedUpdatedAt", "template"], "payload");
  const expectedUpdatedAt =
    typeof payload.expectedUpdatedAt === "string"
      ? payload.expectedUpdatedAt.trim()
      : "";
  if (!expectedUpdatedAt || expectedUpdatedAt.length > 100) {
    throw new TrainingTemplateValidationError(
      "payload.expectedUpdatedAt must contain 1 to 100 characters",
    );
  }
  const parsedTemplate = normaliseTrainingCycleConfig(payload.template);
  if (parsedTemplate.version !== 2) {
    throw new TrainingTemplateValidationError(
      "payload.template.version must equal 2",
    );
  }
  const template = version2TrainingTemplate(parsedTemplate);
  return { expectedUpdatedAt, template };
}

export function assertExistingPhaseIdsPreserved(
  current: TrainingCycleConfig,
  next: TrainingCycleConfig,
) {
  const nextIds = new Set(next.phases.map((phase) => phase.id));
  const removed = current.phases
    .map((phase) => phase.id)
    .filter((phaseId) => !nextIds.has(phaseId));
  if (removed.length > 0) {
    throw new TrainingTemplateValidationError(
      `Agent template updates cannot remove existing phases: ${removed.join(", ")}`,
    );
  }
}

export function version2TrainingTemplate(
  current: TrainingCycleConfig,
): TrainingCycleConfig {
  const usedLabels = new Set<string>();
  const legacyLabel = (value: string, index: number) => {
    const base = (value.trim() || `Phase ${index + 1}`).slice(0, 80);
    let candidate = base;
    let suffixNo = 2;
    const identity = (label: string) =>
      label.normalize("NFKC").trim().toLocaleLowerCase("en");
    while (usedLabels.has(identity(candidate))) {
      const suffix = ` (${suffixNo})`;
      candidate = `${base.slice(0, 80 - suffix.length).trimEnd()}${suffix}`;
      suffixNo += 1;
    }
    usedLabels.add(identity(candidate));
    return candidate;
  };
  return normaliseTrainingCycleConfig({
    version: 2,
    phases: current.phases.map((phase, index) => ({
      ...phase,
      label:
        current.version === 1
          ? legacyLabel(phase.label, index)
          : phase.label,
      routine: phase.kind === "recovery" ? [] : (phase.routine ?? []),
    })),
  });
}

function exerciseIdentity(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en");
}

function setKind(value: string | null): "warmup" | "working" | "unknown" {
  const normalised = value?.normalize("NFKC").trim().toLocaleLowerCase("en");
  if (!normalised) return "unknown";
  if (/warm[\s_-]*up|熱身|热身/.test(normalised)) return "warmup";
  if (/work(?:ing)?|正式|工作/.test(normalised)) return "working";
  return "unknown";
}

function planningSets(rows: readonly TrainingTemplateSet[]) {
  const working = rows.filter((row) => setKind(row.setTypeManual) === "working");
  if (working.length > 0) return working;
  const nonWarmup = rows.filter((row) => setKind(row.setTypeManual) !== "warmup");
  if (nonWarmup.length < rows.length && nonWarmup.length > 0) return nonWarmup;
  if (nonWarmup.length === 0) return [];

  const frequency = new Map<number, number>();
  for (const row of rows) {
    if (row.weightKgReported === null) continue;
    frequency.set(
      row.weightKgReported,
      (frequency.get(row.weightKgReported) ?? 0) + 1,
    );
  }
  const modalWeight = [...frequency.entries()].sort(
    ([leftWeight, leftCount], [rightWeight, rightCount]) =>
      rightCount - leftCount || rightWeight - leftWeight,
  )[0]?.[0];
  if (modalWeight !== undefined) {
    return rows.filter((row) => row.weightKgReported === modalWeight);
  }
  return [...rows];
}

function targetReps(rows: readonly TrainingTemplateSet[]) {
  const values = rows
    .map((row) => row.reps)
    .filter((value): value is number => value !== null && value > 0);
  if (values.length === 0) return undefined;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  return minimum === maximum ? String(minimum) : `${minimum}-${maximum}`;
}

function slotBaseId(exercise: string, index: number) {
  const slug = exercise
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 54)
    .replace(/-+$/g, "");
  return `slot-${slug || index + 1}`;
}

function uniqueSlotId(baseId: string, used: Set<string>) {
  if (!used.has(baseId)) {
    used.add(baseId);
    return baseId;
  }
  let suffix = 2;
  while (true) {
    const candidate = `${baseId.slice(0, 64 - String(suffix).length - 1)}-${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    suffix += 1;
  }
}

function routineFromSession(
  sessionId: string,
  sets: readonly TrainingTemplateSet[],
): {
  routine: TrainingRoutineSlotConfig[];
  omittedExerciseCount: number;
  truncatedExerciseCount: number;
} {
  const grouped = new Map<string, TrainingTemplateSet[]>();
  for (const row of sets
    .filter((set) => set.sessionId === sessionId)
    .sort((left, right) => left.setNoSession - right.setNoSession)) {
    const identity = exerciseIdentity(row.exercise);
    const current = grouped.get(identity) ?? [];
    current.push(row);
    grouped.set(identity, current);
  }

  const usedIds = new Set<string>();
  const routine: TrainingRoutineSlotConfig[] = [];
  let omittedExerciseCount = 0;
  let truncatedExerciseCount = 0;
  for (const rows of grouped.values()) {
    const exercise = rows[0]!.exercise.trim();
    if (!exercise || exercise.length > 120) {
      omittedExerciseCount += 1;
      continue;
    }
    const relevant = planningSets(rows);
    if (relevant.length === 0) continue;
    if (routine.length >= 20) {
      truncatedExerciseCount += 1;
      continue;
    }
    const reps = targetReps(relevant);
    routine.push({
      id: uniqueSlotId(slotBaseId(exercise, routine.length), usedIds),
      label: exercise.slice(0, 80),
      preferredExercise: exercise,
      alternatives: [],
      targetSets: Math.min(20, Math.max(1, relevant.length)),
      ...(reps === undefined ? {} : { targetReps: reps }),
    });
  }
  return { routine, omittedExerciseCount, truncatedExerciseCount };
}

function sessionTimestamp(session: TrainingTemplateSession) {
  const utcTime = Date.parse(session.startedAtUtc ?? "");
  return Number.isFinite(utcTime) ? utcTime : Date.parse(session.startedAt);
}

export function deriveTrainingTemplateProposal(
  current: TrainingCycleConfig,
  sessions: readonly TrainingTemplateSession[],
  sets: readonly TrainingTemplateSet[],
): TrainingTemplateProposal {
  const base = version2TrainingTemplate(current);
  const latestSessions = [...sessions].sort((left, right) => {
    const leftTime = sessionTimestamp(left);
    const rightTime = sessionTimestamp(right);
    const timeOrder =
      (Number.isFinite(rightTime) ? rightTime : Number.NEGATIVE_INFINITY) -
      (Number.isFinite(leftTime) ? leftTime : Number.NEGATIVE_INFINITY);
    return timeOrder || left.sessionId.localeCompare(right.sessionId);
  });
  const sources: TrainingTemplateProposalSource[] = [];
  const warnings: TrainingTemplateProposalWarning[] = [];
  const phases = base.phases.map((phase) => {
    if (phase.kind === "recovery") {
      sources.push({ phaseId: phase.id, status: "kept_existing" });
      return { ...phase, routine: [] };
    }
    if ((phase.routine?.length ?? 0) > 0) {
      sources.push({ phaseId: phase.id, status: "kept_existing" });
      return { ...phase, routine: phase.routine!.map((slot) => ({ ...slot })) };
    }
    const session = latestSessions.find(
      (candidate) => candidate.trainingPhaseId === phase.id,
    );
    if (!session) {
      sources.push({ phaseId: phase.id, status: "no_history" });
      return { ...phase, routine: [] };
    }
    const draft = routineFromSession(session.sessionId, sets);
    const routine = draft.routine;
    if (draft.omittedExerciseCount > 0) {
      warnings.push({
        phaseId: phase.id,
        code: "history_exercise_name_unsupported",
        count: draft.omittedExerciseCount,
      });
    }
    if (draft.truncatedExerciseCount > 0) {
      warnings.push({
        phaseId: phase.id,
        code: "history_routine_items_truncated",
        count: draft.truncatedExerciseCount,
      });
    }
    sources.push({
      phaseId: phase.id,
      status: routine.length > 0 ? "derived_history" : "no_history",
      sessionId: session.sessionId,
      sessionTitle: session.sessionTitle,
      localDate: session.localDate,
    });
    return { ...phase, routine };
  });
  const template = normaliseTrainingCycleConfig({ version: 2, phases });
  return { template, sources, warnings };
}
