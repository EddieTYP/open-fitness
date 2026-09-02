import { createHash } from "node:crypto";

import {
  exerciseIdentity,
  type TrainingCycleConfig,
  type TrainingRoutineSlotConfig,
} from "./training-cycle.ts";

export type TrainingSelectionScope = "date" | "venue" | "template";

export type TrainingExerciseSelectionInput = {
  phaseId: string;
  slotId: string;
  exercise: string;
  scope: TrainingSelectionScope;
  date?: string;
  venue?: string;
  expectedUpdatedAt?: string;
};

export type TrainingSelectionRow = {
  selectionId: string;
  phaseId: string;
  slotId: string;
  scope: "date" | "venue";
  scopeValue: string;
  exercise: string;
  overrideBatchId?: string | null;
  prescriptionOverride?: string | null;
  loadGuidanceOverride?: string | null;
  effortOverride?: string | null;
  recordedAt: string;
};

export class TrainingSelectionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrainingSelectionValidationError";
  }
}

const STABLE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HISTORY_SLOT_ID = /^history-[0-9a-f]{24}$/;

export function historyExerciseSlotId(sourceSetId: string) {
  return `history-${createHash("sha256")
    .update(sourceSetId, "utf8")
    .digest("hex")
    .slice(0, 24)}`;
}

export function isHistoryExerciseSlotId(value: string) {
  return HISTORY_SLOT_ID.test(value);
}

export function isCurrentDateSelectionTarget({
  plan,
  date,
  phaseId,
  slotId,
}: {
  plan: {
    planningDate: string;
    phaseId: string | null;
    items: Array<{ phaseId?: string; slotId?: string }>;
  } | null;
  date: string;
  phaseId: string;
  slotId: string;
}) {
  return Boolean(
    plan &&
      plan.planningDate === date &&
      plan.phaseId === phaseId &&
      plan.items.some(
        (item) => item.phaseId === phaseId && item.slotId === slotId,
      ),
  );
}

function requiredText(value: unknown, path: string, maximumLength: number) {
  if (typeof value !== "string") {
    throw new TrainingSelectionValidationError(`${path} must be a string`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new TrainingSelectionValidationError(
      path + " must not contain control characters or line breaks",
    );
  }
  const text = value.trim();
  if (text.length < 1 || text.length > maximumLength) {
    throw new TrainingSelectionValidationError(
      `${path} must contain 1 to ${maximumLength} characters`,
    );
  }
  return text;
}

export function venueSelectionKey(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function normaliseTrainingExerciseSelection(
  value: unknown,
): TrainingExerciseSelectionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TrainingSelectionValidationError("selection must be an object");
  }
  const payload = value as Record<string, unknown>;
  const allowed = [
    "phaseId",
    "slotId",
    "exercise",
    "scope",
    "date",
    "venue",
    "expectedUpdatedAt",
  ];
  const unknown = Object.keys(payload).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new TrainingSelectionValidationError(
      `selection contains unknown field(s): ${unknown.join(", ")}`,
    );
  }
  const phaseId = requiredText(payload.phaseId, "phaseId", 64);
  const slotId = requiredText(payload.slotId, "slotId", 64);
  if (!STABLE_ID.test(phaseId) || !STABLE_ID.test(slotId)) {
    throw new TrainingSelectionValidationError(
      "phaseId and slotId must be lowercase stable identifiers",
    );
  }
  const exercise = requiredText(payload.exercise, "exercise", 120);
  if (
    payload.scope !== "date" &&
    payload.scope !== "venue" &&
    payload.scope !== "template"
  ) {
    throw new TrainingSelectionValidationError(
      "scope must be date, venue or template",
    );
  }
  const result: TrainingExerciseSelectionInput = {
    phaseId,
    slotId,
    exercise,
    scope: payload.scope,
  };
  if (payload.scope === "date") {
    const date = requiredText(payload.date, "date", 10);
    if (!ISO_DATE.test(date)) {
      throw new TrainingSelectionValidationError("date must use YYYY-MM-DD");
    }
    result.date = date;
  }
  if (payload.scope === "venue") {
    result.venue = requiredText(payload.venue, "venue", 120);
  }
  if (payload.scope === "template") {
    result.expectedUpdatedAt = requiredText(
      payload.expectedUpdatedAt,
      "expectedUpdatedAt",
      100,
    );
  }
  return result;
}

export function routineSlot(
  config: TrainingCycleConfig,
  phaseId: string,
  slotId: string,
): TrainingRoutineSlotConfig {
  const slot = config.phases
    .find((phase) => phase.id === phaseId)
    ?.routine?.find((candidate) => candidate.id === slotId);
  if (!slot) {
    throw new TrainingSelectionValidationError(
      "The selected routine item no longer exists",
    );
  }
  return slot;
}

export function allowedExercise(
  slot: TrainingRoutineSlotConfig,
  exercise: string,
) {
  const identity = exerciseIdentity(exercise);
  return [slot.preferredExercise, ...slot.alternatives].find(
    (candidate) => exerciseIdentity(candidate) === identity,
  );
}

export function effectiveExerciseSelection({
  phaseId,
  slot,
  date,
  venue,
  selections,
  fallbackSource = "template",
}: {
  phaseId: string;
  slot: TrainingRoutineSlotConfig;
  date: string;
  venue: string | null;
  selections: TrainingSelectionRow[];
  fallbackSource?: "template" | "history";
}) {
  const venueKey = venue ? venueSelectionKey(venue) : null;
  const matching = selections
    .filter(
      (selection) =>
        selection.phaseId === phaseId && selection.slotId === slot.id,
    )
    .sort((left, right) =>
      `${right.recordedAt}|${right.selectionId}`.localeCompare(
        `${left.recordedAt}|${left.selectionId}`,
      ),
    );
  const dateSelection = matching.find(
    (selection) =>
      selection.scope === "date" && selection.scopeValue === date,
  );
  const venueSelection = matching.find(
    (selection) =>
      venueKey !== null &&
      selection.scope === "venue" &&
      selection.scopeValue === venueKey,
  );
  if (dateSelection) {
    return {
      exercise: dateSelection.exercise,
      source: "date" as const,
      prescriptionOverride: dateSelection.prescriptionOverride ?? null,
      loadGuidanceOverride: dateSelection.loadGuidanceOverride ?? null,
      effortOverride: dateSelection.effortOverride ?? null,
    };
  }
  const venueExercise =
    venueSelection && allowedExercise(slot, venueSelection.exercise);
  if (venueExercise) {
    return {
      exercise: venueExercise,
      source: "venue" as const,
      prescriptionOverride: null,
      loadGuidanceOverride: null,
      effortOverride: null,
    };
  }
  return {
    exercise: slot.preferredExercise,
    source: fallbackSource,
    prescriptionOverride: null,
    loadGuidanceOverride: null,
    effortOverride: null,
  };
}

export function replacePreferredExercise(
  config: TrainingCycleConfig,
  phaseId: string,
  slotId: string,
  exercise: string,
): TrainingCycleConfig {
  const slot = routineSlot(config, phaseId, slotId);
  const canonical = allowedExercise(slot, exercise);
  if (!canonical) {
    throw new TrainingSelectionValidationError(
      "exercise must be the preferred exercise or a configured alternative",
    );
  }
  if (exerciseIdentity(canonical) === exerciseIdentity(slot.preferredExercise)) {
    return config;
  }
  return {
    version: 2,
    phases: config.phases.map((phase) =>
      phase.id !== phaseId
        ? phase
        : {
            ...phase,
            routine: phase.routine?.map((candidate) =>
              candidate.id !== slotId
                ? candidate
                : {
                    ...candidate,
                    preferredExercise: canonical,
                    alternatives: [
                      slot.preferredExercise,
                      ...slot.alternatives.filter(
                        (alternative) =>
                          exerciseIdentity(alternative) !==
                          exerciseIdentity(canonical),
                      ),
                    ],
                  },
            ),
          },
    ),
  };
}
