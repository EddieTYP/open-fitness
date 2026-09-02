import {
  activeCalendarDaysBetween,
  type TrainingPauseInterval,
} from "./training-schedule.ts";

export type PlanCategory =
  | "push"
  | "pull"
  | "leg"
  | "training"
  | "recovery"
  | "unknown";

export type TrainingPhaseKind = "training" | "recovery";
export type TrainingAdjustment = "normal" | "reduce" | "recover";

export type TrainingRoutineSlotConfig = {
  id: string;
  label: string;
  preferredExercise: string;
  alternatives: string[];
  targetSets?: number;
  targetReps?: string;
  targetEffort?: string;
  loadIncrementKg?: number;
};

export type TrainingCyclePhaseConfig = {
  id: string;
  label: string;
  kind: TrainingPhaseKind;
  routine?: TrainingRoutineSlotConfig[];
};

export type TrainingCycleConfig = {
  version: 1 | 2;
  phases: TrainingCyclePhaseConfig[];
};

export type CyclePhase = {
  id: string;
  raw: string;
  kind: TrainingPhaseKind;
  category: Exclude<PlanCategory, "unknown">;
  routine?: TrainingRoutineSlotConfig[];
};

export type CycleCompletionNote = {
  noteId: string;
  noteDate: string;
  noteType: string;
  exerciseOrArea: string | null;
  note: string;
};

type CycleCompletionEvidence = {
  category: "recovery";
  date: string;
  orderKey: string;
};

type JsonObject = Record<string, unknown>;

const MAX_PHASES = 12;
const MAX_PHASE_LABEL_LENGTH = 80;
const MAX_ROUTINE_SLOTS = 20;
const MAX_ALTERNATIVES = 8;
const MAX_EXERCISE_LENGTH = 120;
const MAX_TARGET_LENGTH = 40;
const PHASE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class TrainingCycleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrainingCycleValidationError";
  }
}

export function trainingAdjustmentFor({
  phaseKind,
  pain010,
  recoveryAgeDays,
}: {
  phaseKind: TrainingPhaseKind;
  pain010: number | null | undefined;
  recoveryAgeDays: number | null;
}): TrainingAdjustment {
  if (
    phaseKind !== "training" ||
    pain010 === null ||
    pain010 === undefined ||
    recoveryAgeDays === null ||
    recoveryAgeDays < 0 ||
    recoveryAgeDays > 3
  ) {
    return "normal";
  }
  if (pain010 >= 4) return "recover";
  if (pain010 >= 2) return "reduce";
  return "normal";
}

function objectValue(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TrainingCycleValidationError(`${path} must be an object`);
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
    throw new TrainingCycleValidationError(
      `${path} contains unknown field(s): ${unknown.join(", ")}`,
    );
  }
}

export function phaseIdentity(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_/·•|:()（）\-]+/g, " ")
    .trim();
}

export const exerciseIdentity = phaseIdentity;

function requiredText(
  value: unknown,
  path: string,
  maximumLength: number,
) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < 1 || text.length > maximumLength) {
    throw new TrainingCycleValidationError(
      `${path} must contain 1 to ${maximumLength} characters`,
    );
  }
  return text;
}

function optionalTarget(value: unknown, path: string) {
  if (value === undefined) return undefined;
  return requiredText(value, path, MAX_TARGET_LENGTH);
}

function normaliseRoutine(value: unknown, path: string) {
  if (!Array.isArray(value) || value.length > MAX_ROUTINE_SLOTS) {
    throw new TrainingCycleValidationError(
      `${path} must contain 0 to ${MAX_ROUTINE_SLOTS} items`,
    );
  }
  const ids = new Set<string>();
  return value.map<TrainingRoutineSlotConfig>((rawSlot, index) => {
    const slotPath = `${path}[${index}]`;
    const slot = objectValue(rawSlot, slotPath);
    assertKnownFields(
      slot,
      [
        "id",
        "label",
        "preferredExercise",
        "alternatives",
        "targetSets",
        "targetReps",
        "targetEffort",
        "loadIncrementKg",
      ],
      slotPath,
    );
    const id = typeof slot.id === "string" ? slot.id.trim() : "";
    if (!PHASE_ID_PATTERN.test(id)) {
      throw new TrainingCycleValidationError(
        `${slotPath}.id must be a lowercase stable identifier`,
      );
    }
    if (ids.has(id)) {
      throw new TrainingCycleValidationError(`${slotPath}.id must be unique`);
    }
    ids.add(id);
    const label = requiredText(slot.label, `${slotPath}.label`, 80);
    const preferredExercise = requiredText(
      slot.preferredExercise,
      `${slotPath}.preferredExercise`,
      MAX_EXERCISE_LENGTH,
    );
    if (
      !Array.isArray(slot.alternatives) ||
      slot.alternatives.length > MAX_ALTERNATIVES
    ) {
      throw new TrainingCycleValidationError(
        `${slotPath}.alternatives must contain 0 to ${MAX_ALTERNATIVES} exercises`,
      );
    }
    const exercises = new Set([exerciseIdentity(preferredExercise)]);
    const alternatives = slot.alternatives.map((alternative, alternativeIndex) => {
      const normalised = requiredText(
        alternative,
        `${slotPath}.alternatives[${alternativeIndex}]`,
        MAX_EXERCISE_LENGTH,
      );
      const identity = exerciseIdentity(normalised);
      if (exercises.has(identity)) {
        throw new TrainingCycleValidationError(
          `${slotPath}.alternatives must be unique and different from preferredExercise`,
        );
      }
      exercises.add(identity);
      return normalised;
    });
    let targetSets: number | undefined;
    if (slot.targetSets !== undefined) {
      if (
        typeof slot.targetSets !== "number" ||
        !Number.isInteger(slot.targetSets) ||
        slot.targetSets < 1 ||
        slot.targetSets > 20
      ) {
        throw new TrainingCycleValidationError(
          `${slotPath}.targetSets must be an integer from 1 to 20`,
        );
      }
      targetSets = slot.targetSets;
    }
    const targetReps = optionalTarget(slot.targetReps, `${slotPath}.targetReps`);
    const targetEffort = optionalTarget(
      slot.targetEffort,
      `${slotPath}.targetEffort`,
    );
    let loadIncrementKg: number | undefined;
    if (slot.loadIncrementKg !== undefined) {
      if (
        typeof slot.loadIncrementKg !== "number" ||
        !Number.isFinite(slot.loadIncrementKg) ||
        slot.loadIncrementKg <= 0 ||
        slot.loadIncrementKg > 100
      ) {
        throw new TrainingCycleValidationError(
          `${slotPath}.loadIncrementKg must be a number greater than 0 and at most 100`,
        );
      }
      loadIncrementKg = slot.loadIncrementKg;
    }
    return {
      id,
      label,
      preferredExercise,
      alternatives,
      ...(targetSets === undefined ? {} : { targetSets }),
      ...(targetReps === undefined ? {} : { targetReps }),
      ...(targetEffort === undefined ? {} : { targetEffort }),
      ...(loadIncrementKg === undefined ? {} : { loadIncrementKg }),
    };
  });
}

export function normaliseTrainingCycleConfig(
  value: unknown,
): TrainingCycleConfig {
  const config = objectValue(value, "trainingCycleConfig");
  assertKnownFields(config, ["version", "phases"], "trainingCycleConfig");
  if (config.version !== 1 && config.version !== 2) {
    throw new TrainingCycleValidationError(
      "trainingCycleConfig.version must equal 1 or 2",
    );
  }
  if (
    !Array.isArray(config.phases) ||
    config.phases.length < 1 ||
    config.phases.length > MAX_PHASES
  ) {
    throw new TrainingCycleValidationError(
      `trainingCycleConfig.phases must contain 1 to ${MAX_PHASES} phases`,
    );
  }

  const ids = new Set<string>();
  const labels = new Set<string>();
  const phases = config.phases.map((rawPhase, index) => {
    const path = `trainingCycleConfig.phases[${index}]`;
    const phase = objectValue(rawPhase, path);
    assertKnownFields(
      phase,
      config.version === 2
        ? ["id", "label", "kind", "routine"]
        : ["id", "label", "kind"],
      path,
    );
    const id = typeof phase.id === "string" ? phase.id.trim() : "";
    const label = typeof phase.label === "string" ? phase.label.trim() : "";
    if (!PHASE_ID_PATTERN.test(id)) {
      throw new TrainingCycleValidationError(
        `${path}.id must be a lowercase stable identifier`,
      );
    }
    if (ids.has(id)) {
      throw new TrainingCycleValidationError(`${path}.id must be unique`);
    }
    if (label.length < 1 || label.length > MAX_PHASE_LABEL_LENGTH) {
      throw new TrainingCycleValidationError(
        `${path}.label must contain 1 to ${MAX_PHASE_LABEL_LENGTH} characters`,
      );
    }
    const identity = phaseIdentity(label);
    if (labels.has(identity)) {
      throw new TrainingCycleValidationError(`${path}.label must be unique`);
    }
    if (phase.kind !== "training" && phase.kind !== "recovery") {
      throw new TrainingCycleValidationError(
        `${path}.kind must be training or recovery`,
      );
    }
    const kind: TrainingPhaseKind = phase.kind;
    const routine =
      config.version === 2 && phase.routine !== undefined
        ? normaliseRoutine(phase.routine, `${path}.routine`)
        : undefined;
    if (kind === "recovery" && routine && routine.length > 0) {
      throw new TrainingCycleValidationError(
        `${path}.routine is only allowed on a training day`,
      );
    }
    ids.add(id);
    labels.add(identity);
    return { id, label, kind, ...(routine === undefined ? {} : { routine }) };
  });
  if (!phases.some((phase) => phase.kind === "training")) {
    throw new TrainingCycleValidationError(
      "trainingCycleConfig must contain at least one training phase",
    );
  }
  return { version: config.version, phases };
}

export function parseStoredTrainingCycleConfig(
  value: unknown,
): TrainingCycleConfig | null {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (parsed === null || parsed === undefined) return null;
    return normaliseTrainingCycleConfig(parsed);
  } catch {
    return null;
  }
}

export function planCategory(title: string): PlanCategory {
  const value = title.toLowerCase();
  if (value.includes("push") || value.includes("胸")) return "push";
  if (value.includes("pull") || value.includes("背")) return "pull";
  if (value.includes("leg") || value.includes("腿")) return "leg";
  if (
    value.includes("rest") ||
    value.includes("recovery") ||
    value.includes("恢復") ||
    value.includes("休息") ||
    value.includes("conditioning")
  ) {
    return "recovery";
  }
  return "unknown";
}

function legacyCycleConfig(value: string | undefined): TrainingCycleConfig {
  const labels = (value ?? "")
    .split(/\s*\/\s*/)
    .map((label) => label.trim())
    .filter(Boolean);
  return {
    version: 1,
    phases: labels.map<TrainingCyclePhaseConfig>((label, index) => ({
      id: `legacy-phase-${index + 1}`,
      label,
      kind: planCategory(label) === "recovery" ? "recovery" : "training",
    })),
  };
}

export function effectiveTrainingCycleConfig(
  trainingCycle: string | undefined,
  storedConfig?: unknown,
): TrainingCycleConfig {
  return (
    parseStoredTrainingCycleConfig(storedConfig) ?? legacyCycleConfig(trainingCycle)
  );
}

function categoryForPhase(
  label: string,
  kind: TrainingPhaseKind,
): Exclude<PlanCategory, "unknown"> {
  if (kind === "recovery") return "recovery";
  const category = planCategory(label);
  return category === "push" || category === "pull" || category === "leg"
    ? category
    : "training";
}

export function parseCycle(
  value: string | undefined,
  storedConfig?: unknown,
): CyclePhase[] {
  const structured = parseStoredTrainingCycleConfig(storedConfig);
  const config = structured ?? legacyCycleConfig(value);
  return config.phases.map((phase) => ({
    id: phase.id,
    raw: phase.label,
    kind: phase.kind,
    category:
      phase.kind === "recovery"
        ? "recovery"
        : structured
          ? "training"
          : categoryForPhase(phase.label, phase.kind),
    ...(phase.routine === undefined ? {} : { routine: phase.routine }),
  }));
}

function rawPhaseMatchesTitle(phaseLabel: string, title: string) {
  const titleIdentity = phaseIdentity(title);
  const identity = phaseIdentity(phaseLabel);
  return (
    identity !== "" &&
    (titleIdentity === identity ||
      titleIdentity.startsWith(`${identity} `) ||
      titleIdentity.includes(` ${identity} `) ||
      titleIdentity.endsWith(` ${identity}`))
  );
}

export function sessionMatchesCyclePhase({
  phase,
  sessionTitle,
  sessionType,
  trainingPhaseId,
}: {
  phase: CyclePhase;
  sessionTitle: string | undefined;
  sessionType?: string | null;
  trainingPhaseId?: string | null;
}) {
  if (trainingPhaseId) return trainingPhaseId === phase.id;
  if (!sessionTitle) return false;
  if (rawPhaseMatchesTitle(phase.raw, sessionTitle)) {
    return (
      sessionType === undefined ||
      sessionType === "Strength" ||
      phase.category === "training" ||
      phaseIdentity(phase.raw) === phaseIdentity(sessionTitle)
    );
  }
  if (sessionType !== undefined && sessionType !== "Strength") return false;
  const sessionCategory = planCategory(sessionTitle);
  return (
    phase.category !== "training" &&
    sessionCategory !== "unknown" &&
    phase.category === sessionCategory
  );
}

export function inferSessionTrainingPhaseId(
  phases: CyclePhase[],
  sessionTitle: string | undefined,
  sessionType?: string | null,
): string | null {
  if (!sessionTitle) return null;
  const matches = phases.filter((phase) =>
    sessionMatchesCyclePhase({ phase, sessionTitle, sessionType }),
  );
  return matches.length === 1 ? matches[0].id : null;
}

export function matchedCompletedTrainingPhase({
  phases,
  sessionTitle,
  sessionType,
  trainingPhaseId,
}: {
  phases: CyclePhase[];
  sessionTitle: string | undefined;
  sessionType?: string | null;
  trainingPhaseId?: string | null;
}): CyclePhase | null {
  if (trainingPhaseId) {
    const phase = phases.find((entry) => entry.id === trainingPhaseId);
    return phase?.kind === "training" ? phase : null;
  }
  if (!sessionTitle) return null;
  const trainingPhases = phases.filter((phase) => phase.kind === "training");
  const rawMatches = trainingPhases
    .filter((phase) => rawPhaseMatchesTitle(phase.raw, sessionTitle))
    .sort((left, right) => right.raw.length - left.raw.length);
  if (
    rawMatches[0] &&
    (!rawMatches[1] || rawMatches[0].raw.length > rawMatches[1].raw.length) &&
    (sessionType === undefined ||
      sessionType === "Strength" ||
      rawMatches[0].category === "training" ||
      phaseIdentity(rawMatches[0].raw) === phaseIdentity(sessionTitle))
  ) {
    return rawMatches[0];
  }

  if (sessionType !== undefined && sessionType !== "Strength") return null;
  const category = planCategory(sessionTitle);
  if (category === "unknown" || category === "training") return null;
  const categoryMatches = trainingPhases.filter(
    (phase) => phase.category === category,
  );
  return categoryMatches.length === 1 ? categoryMatches[0] : null;
}

function phaseIndexForSession(
  phases: CyclePhase[],
  title: string | undefined,
  trainingPhaseId?: string | null,
  sessionType?: string | null,
) {
  const phase = matchedCompletedTrainingPhase({
    phases,
    sessionTitle: title,
    sessionType,
    trainingPhaseId,
  });
  return phase ? phases.indexOf(phase) : -1;
}

export function cycleCompletionEvidence(
  notes: CycleCompletionNote[],
): CycleCompletionEvidence[] {
  return notes.flatMap((entry) => {
    const category = planCategory(
      `${entry.exerciseOrArea ?? ""} ${entry.note}`,
    );
    const isStructuredCompletion =
      entry.noteType === "Cycle phase completed" && category === "recovery";
    const isExplicitRecovery =
      entry.noteType === "Explicit non-event" && category === "recovery";

    if (!isStructuredCompletion && !isExplicitRecovery) return [];
    return [
      {
        category: "recovery" as const,
        date: entry.noteDate,
        orderKey: `${entry.noteDate}\u0000${entry.noteId}`,
      },
    ];
  });
}

export function inferNextCyclePhase({
  trainingCycle,
  trainingCycleConfig,
  latestCompletedTitle,
  latestCompletedPhaseId,
  latestCompletedDate,
  latestCompletedSessionType,
  latestStrengthTitle,
  latestStrengthPhaseId,
  latestStrengthDate,
  completionNotes,
  planningDate,
  pausedIntervals = [],
}: {
  trainingCycle: string | undefined;
  trainingCycleConfig?: unknown;
  latestCompletedTitle?: string;
  latestCompletedPhaseId?: string | null;
  latestCompletedDate?: string;
  latestCompletedSessionType?: string | null;
  latestStrengthTitle?: string;
  latestStrengthPhaseId?: string | null;
  latestStrengthDate?: string;
  completionNotes: CycleCompletionNote[];
  planningDate: string;
  pausedIntervals?: TrainingPauseInterval[];
}): CyclePhase | null {
  const phases = parseCycle(trainingCycle, trainingCycleConfig);
  const fallback = phases[0] ?? null;
  if (!fallback) return null;

  let completedIndex = phaseIndexForSession(
    phases,
    latestCompletedTitle ?? latestStrengthTitle,
    latestCompletedPhaseId ?? latestStrengthPhaseId,
    latestCompletedTitle !== undefined ||
      latestCompletedPhaseId !== undefined ||
      latestCompletedDate !== undefined
      ? latestCompletedSessionType
      : "Strength",
  );
  let completionAnchorDate = latestCompletedDate ?? latestStrengthDate;
  const structured = parseStoredTrainingCycleConfig(trainingCycleConfig);
  const evidence = structured
    ? []
    : cycleCompletionEvidence(completionNotes).sort((a, b) =>
        a.orderKey.localeCompare(b.orderKey),
      );

  if (completedIndex < 0) {
    const latestCompletion = evidence.at(-1);
    if (!latestCompletion) return fallback;
    completedIndex = phases.findIndex(
      (phase) => phase.category === latestCompletion.category,
    );
    return completedIndex >= 0
      ? phases[(completedIndex + 1) % phases.length]
      : fallback;
  }

  for (const completion of evidence) {
    // Date-only rest notes cannot be ordered safely against a workout on the
    // same day, so only a later local calendar day may consume a phase.
    if (!completionAnchorDate || completion.date <= completionAnchorDate) {
      continue;
    }
    const expectedIndex = (completedIndex + 1) % phases.length;
    if (phases[expectedIndex].category === completion.category) {
      completedIndex = expectedIndex;
      completionAnchorDate = completion.date;
    }
  }

  const activeDays = completionAnchorDate
    ? activeCalendarDaysBetween(
        completionAnchorDate,
        planningDate,
        pausedIntervals,
      )
    : 0;
  for (let day = 0; day < activeDays; day += 1) {
    const expectedIndex = (completedIndex + 1) % phases.length;
    if (phases[expectedIndex].category !== "recovery") break;
    completedIndex = expectedIndex;
  }

  return phases[(completedIndex + 1) % phases.length];
}
