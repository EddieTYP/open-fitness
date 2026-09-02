import { isDateOnly } from "./record-utils.ts";

export const TRAINING_SCHEDULE_CONTRACT_VERSION = 1;

export type TrainingScheduleEventType = "pause" | "resume";

export type TrainingScheduleEventRecord = {
  eventId: string;
  profileId: string;
  effectiveDate: string;
  eventType: TrainingScheduleEventType;
  resumeOn: string | null;
  reason: string | null;
  recordedAt: string;
  createdBy: string;
  voidedAt: string | null;
  voidReason: string | null;
  voidedBy: string | null;
};

export type TrainingPauseInterval = {
  eventId: string;
  startsOn: string;
  resumeOn: string | null;
  reason: string | null;
};

export type TrainingScheduleMutation =
  | {
      action: "pause";
      effectiveDate: string;
      resumeOn: string | null;
      reason: string | null;
    }
  | {
      action: "resume";
      effectiveDate: string;
      resumeOn: null;
      reason: string | null;
    };

export type TrainingScheduleRevision = {
  action: "void" | "restore";
  eventId: string;
  reason: string;
};

export class TrainingScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrainingScheduleValidationError";
  }
}

export const trainingScheduleContract = {
  contractVersion: TRAINING_SCHEDULE_CONTRACT_VERSION,
  timezone: "profile.timezone",
  mutation: {
    method: "POST",
    idempotencyHeader: "x-idempotency-key",
    actions: {
      pause: {
        required: ["action", "effectiveDate"],
        optional: ["resumeOn", "reason"],
        resumeOnMeaning: "first active calendar date in profile.timezone",
      },
      resume: {
        required: ["action", "effectiveDate"],
        optional: ["reason"],
      },
    },
  },
  correction: {
    method: "PATCH",
    idempotencyHeader: "x-idempotency-key",
    actions: ["void", "restore"],
    required: ["action", "eventId", "reason"],
  },
} as const;

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TrainingScheduleValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertKnownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new TrainingScheduleValidationError(
      `unknown field(s): ${unknown.join(", ")}`,
    );
  }
}

function requiredDate(value: unknown, field: string) {
  if (!isDateOnly(value)) {
    throw new TrainingScheduleValidationError(
      `${field} must use YYYY-MM-DD`,
    );
  }
  return value;
}

function optionalReason(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new TrainingScheduleValidationError("reason must be text or null");
  }
  const reason = value.trim();
  if (reason.length > 240) {
    throw new TrainingScheduleValidationError(
      "reason must not exceed 240 characters",
    );
  }
  return reason || null;
}

export function normaliseTrainingScheduleMutation(
  input: unknown,
): TrainingScheduleMutation {
  const value = objectValue(input, "training schedule mutation");
  const action = value.action;
  if (action !== "pause" && action !== "resume") {
    throw new TrainingScheduleValidationError(
      "action must be pause or resume",
    );
  }

  assertKnownFields(
    value,
    action === "pause"
      ? ["action", "effectiveDate", "resumeOn", "reason"]
      : ["action", "effectiveDate", "reason"],
  );
  const effectiveDate = requiredDate(value.effectiveDate, "effectiveDate");
  const reason = optionalReason(value.reason);

  if (action === "resume") {
    return { action, effectiveDate, resumeOn: null, reason };
  }

  const resumeOn =
    value.resumeOn === undefined || value.resumeOn === null || value.resumeOn === ""
      ? null
      : requiredDate(value.resumeOn, "resumeOn");
  if (resumeOn !== null && resumeOn <= effectiveDate) {
    throw new TrainingScheduleValidationError(
      "resumeOn must be later than effectiveDate",
    );
  }
  return { action, effectiveDate, resumeOn, reason };
}

export function normaliseTrainingScheduleRevision(
  input: unknown,
): TrainingScheduleRevision {
  const value = objectValue(input, "training schedule revision");
  assertKnownFields(value, ["action", "eventId", "reason"]);
  if (value.action !== "void" && value.action !== "restore") {
    throw new TrainingScheduleValidationError(
      "action must be void or restore",
    );
  }
  if (typeof value.eventId !== "string" || !value.eventId.trim()) {
    throw new TrainingScheduleValidationError("eventId is required");
  }
  const reason = optionalReason(value.reason);
  if (!reason) {
    throw new TrainingScheduleValidationError("reason is required");
  }
  return {
    action: value.action,
    eventId: value.eventId.trim(),
    reason,
  };
}

function earlierDate(left: string | null, right: string) {
  return left === null || right < left ? right : left;
}

export function deriveTrainingSchedule(
  events: TrainingScheduleEventRecord[],
  planningDate: string,
) {
  const ordered = events
    .filter(
      (event) => event.voidedAt === null && event.effectiveDate <= planningDate,
    )
    .sort((left, right) =>
      `${left.effectiveDate}\u0000${left.recordedAt}\u0000${left.eventId}`.localeCompare(
        `${right.effectiveDate}\u0000${right.recordedAt}\u0000${right.eventId}`,
      ),
    );
  const intervals: TrainingPauseInterval[] = [];
  let current: TrainingPauseInterval | null = null;

  const closeCurrent = (resumeOn: string) => {
    if (!current) return;
    const closed = { ...current, resumeOn: earlierDate(current.resumeOn, resumeOn) };
    if (closed.startsOn < closed.resumeOn) intervals.push(closed);
    current = null;
  };

  for (const event of ordered) {
    if (current?.resumeOn && current.resumeOn <= event.effectiveDate) {
      closeCurrent(current.resumeOn);
    }
    if (event.eventType === "pause") {
      closeCurrent(event.effectiveDate);
      current = {
        eventId: event.eventId,
        startsOn: event.effectiveDate,
        resumeOn: event.resumeOn,
        reason: event.reason,
      };
    } else {
      closeCurrent(event.effectiveDate);
    }
  }

  if (current?.resumeOn && current.resumeOn <= planningDate) {
    closeCurrent(current.resumeOn);
  }

  if (current) intervals.push({ ...current });
  return {
    status: current ? ("paused" as const) : ("active" as const),
    pause: current ? { ...current } : null,
    intervals,
  };
}

export function isPausedDate(
  date: string,
  intervals: TrainingPauseInterval[],
) {
  return intervals.some(
    (interval) =>
      interval.startsOn <= date &&
      (interval.resumeOn === null || date < interval.resumeOn),
  );
}

export function addIsoDateDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function hasActiveCalendarDayBetween(
  completedOn: string,
  planningDate: string,
  intervals: TrainingPauseInterval[],
) {
  return activeCalendarDaysBetween(completedOn, planningDate, intervals) > 0;
}

export function activeCalendarDaysBetween(
  completedOn: string,
  planningDate: string,
  intervals: TrainingPauseInterval[],
) {
  let count = 0;
  for (
    let date = addIsoDateDays(completedOn, 1);
    date < planningDate;
    date = addIsoDateDays(date, 1)
  ) {
    if (!isPausedDate(date, intervals)) count += 1;
  }
  return count;
}
