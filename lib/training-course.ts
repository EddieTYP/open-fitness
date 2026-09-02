import { createHash } from "node:crypto";

import type { UiText } from "./i18n/ui-text.ts";

export type TrainingCourseItemOverride = {
  slotId: string;
  exercise: string;
  prescription: string;
  loadGuidance: string;
  effort: string;
};

export type TrainingCourseOverrideInput =
  | {
      scope: "date";
      phaseId: string;
      date: string;
      expectedPlanFingerprint: string;
      items: TrainingCourseItemOverride[];
    }
  | {
      scope: "next_normal_occurrence";
      phaseId: string;
      trainingBlockId: string;
      sourceSessionId: string | null;
      expectedProgressionFingerprint: string;
      items: TrainingCourseItemOverride[];
    }
  | {
      scope: "planned_session";
      phaseId: string;
      date: string;
      trainingBlockId: string;
      sessionIntent: "deload" | "test";
      expectedPlanFingerprint: string;
      items: TrainingCourseItemOverride[];
    };

export class TrainingCourseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrainingCourseValidationError";
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const STABLE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function objectValue(value: unknown, path: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TrainingCourseValidationError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  path: string,
) {
  const unknown = Object.keys(value).filter((key) => !fields.includes(key));
  if (unknown.length > 0) {
    throw new TrainingCourseValidationError(
      `${path} contains unknown field(s): ${unknown.join(", ")}`,
    );
  }
}

function textValue(
  value: unknown,
  path: string,
  maximumLength: number,
) {
  if (typeof value !== "string") {
    throw new TrainingCourseValidationError(`${path} must be a string`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new TrainingCourseValidationError(
      `${path} must not contain control characters or line breaks`,
    );
  }
  const result = value.trim();
  if (result.length < 1 || result.length > maximumLength) {
    throw new TrainingCourseValidationError(
      `${path} must contain 1 to ${maximumLength} characters`,
    );
  }
  return result;
}

export function normaliseTrainingCourseOverride(
  value: unknown,
): TrainingCourseOverrideInput {
  const payload = objectValue(value, "course");
  exactFields(
    payload,
    [
      "scope",
      "phaseId",
      "date",
      "trainingBlockId",
      "sessionIntent",
      "sourceSessionId",
      "expectedPlanFingerprint",
      "expectedProgressionFingerprint",
      "items",
    ],
    "course",
  );
  if (
    payload.scope !== "date" &&
    payload.scope !== "next_normal_occurrence" &&
    payload.scope !== "planned_session"
  ) {
    throw new TrainingCourseValidationError(
      "scope must be date, next_normal_occurrence, or planned_session",
    );
  }
  const phaseId = textValue(payload.phaseId, "phaseId", 64);
  if (!STABLE_ID.test(phaseId)) {
    throw new TrainingCourseValidationError(
      "phaseId must be a lowercase stable identifier",
    );
  }
  if (!Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > 20) {
    throw new TrainingCourseValidationError("items must contain 1 to 20 entries");
  }
  const seen = new Set<string>();
  const items = payload.items.map((rawItem, index) => {
    const item = objectValue(rawItem, `items[${index}]`);
    exactFields(
      item,
      ["slotId", "exercise", "prescription", "loadGuidance", "effort"],
      `items[${index}]`,
    );
    const slotId = textValue(item.slotId, `items[${index}].slotId`, 64);
    if (!STABLE_ID.test(slotId)) {
      throw new TrainingCourseValidationError(
        `items[${index}].slotId must be a lowercase stable identifier`,
      );
    }
    if (seen.has(slotId)) {
      throw new TrainingCourseValidationError(`items contains duplicate slotId ${slotId}`);
    }
    seen.add(slotId);
    return {
      slotId,
      exercise: textValue(item.exercise, `items[${index}].exercise`, 120),
      prescription: textValue(
        item.prescription,
        `items[${index}].prescription`,
        80,
      ),
      loadGuidance: textValue(
        item.loadGuidance,
        `items[${index}].loadGuidance`,
        120,
      ),
      effort: textValue(item.effort, `items[${index}].effort`, 40),
    };
  });
  if (payload.scope === "date") {
    if (
      payload.trainingBlockId !== undefined ||
      payload.sessionIntent !== undefined ||
      payload.sourceSessionId !== undefined ||
      payload.expectedProgressionFingerprint !== undefined
    ) {
      throw new TrainingCourseValidationError(
        "date scope must not include trainingBlockId, sessionIntent, or sourceSessionId",
      );
    }
    const date = textValue(payload.date, "date", 10);
    if (!ISO_DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
      throw new TrainingCourseValidationError("date must use YYYY-MM-DD");
    }
    const expectedPlanFingerprint = textValue(
      payload.expectedPlanFingerprint,
      "expectedPlanFingerprint",
      64,
    );
    if (!SHA256.test(expectedPlanFingerprint)) {
      throw new TrainingCourseValidationError(
        "expectedPlanFingerprint must be a lowercase SHA-256 digest",
      );
    }
    return {
      scope: "date",
      phaseId,
      date,
      expectedPlanFingerprint,
      items,
    };
  }
  if (payload.scope === "planned_session") {
    if (
      payload.sourceSessionId !== undefined ||
      payload.expectedProgressionFingerprint !== undefined
    ) {
      throw new TrainingCourseValidationError(
        "planned_session scope must not include sourceSessionId or expectedProgressionFingerprint",
      );
    }
    const date = textValue(payload.date, "date", 10);
    if (!ISO_DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
      throw new TrainingCourseValidationError("date must use YYYY-MM-DD");
    }
    const trainingBlockId = textValue(
      payload.trainingBlockId,
      "trainingBlockId",
      120,
    );
    if (payload.sessionIntent !== "deload" && payload.sessionIntent !== "test") {
      throw new TrainingCourseValidationError(
        "sessionIntent must be deload or test",
      );
    }
    const expectedPlanFingerprint = textValue(
      payload.expectedPlanFingerprint,
      "expectedPlanFingerprint",
      64,
    );
    if (!SHA256.test(expectedPlanFingerprint)) {
      throw new TrainingCourseValidationError(
        "expectedPlanFingerprint must be a lowercase SHA-256 digest",
      );
    }
    return {
      scope: "planned_session",
      phaseId,
      date,
      trainingBlockId,
      sessionIntent: payload.sessionIntent,
      expectedPlanFingerprint,
      items,
    };
  }
  if (payload.date !== undefined) {
    throw new TrainingCourseValidationError(
      "next_normal_occurrence scope must not include date",
    );
  }
  if (payload.expectedPlanFingerprint !== undefined) {
    throw new TrainingCourseValidationError(
      "next_normal_occurrence scope must not include expectedPlanFingerprint",
    );
  }
  if (payload.sessionIntent !== undefined) {
    throw new TrainingCourseValidationError(
      "next_normal_occurrence scope must not include sessionIntent",
    );
  }
  const trainingBlockId = textValue(
    payload.trainingBlockId,
    "trainingBlockId",
    120,
  );
  const sourceSessionId =
    payload.sourceSessionId === null || payload.sourceSessionId === undefined
      ? null
      : textValue(payload.sourceSessionId, "sourceSessionId", 200);
  const expectedProgressionFingerprint = textValue(
    payload.expectedProgressionFingerprint,
    "expectedProgressionFingerprint",
    64,
  );
  if (!SHA256.test(expectedProgressionFingerprint)) {
    throw new TrainingCourseValidationError(
      "expectedProgressionFingerprint must be a lowercase SHA-256 digest",
    );
  }
  return {
    scope: "next_normal_occurrence",
    phaseId,
    trainingBlockId,
    sourceSessionId,
    expectedProgressionFingerprint,
    items,
  };
}

export function trainingCourseFingerprint(plan: {
  planningDate: string;
  phaseId: string | null;
  items: Array<{
    phase: string;
    slotId?: string;
    exercise: UiText;
    prescription: UiText;
    loadGuidance: UiText;
    effort: UiText;
  }>;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        planningDate: plan.planningDate,
        phaseId: plan.phaseId,
        items: plan.items.map((item) => ({
          phase: item.phase,
          slotId: item.slotId ?? null,
          exercise: item.exercise,
          prescription: item.prescription,
          loadGuidance: item.loadGuidance,
          effort: item.effort,
        })),
      }),
      "utf8",
    )
    .digest("hex");
}
