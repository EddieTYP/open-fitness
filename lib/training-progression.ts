import { createHash } from "node:crypto";

import { canonicalExerciseIdentity } from "./exercise-display.ts";
import type {
  CyclePhase,
  TrainingRoutineSlotConfig,
} from "./training-cycle.ts";

export type ProgressionSession = {
  sessionId: string;
  trainingPhaseId: string | null;
  trainingBlockId: string | null;
  sessionIntent: "normal" | "deload" | "test";
  startedAt: string;
  startedAtUtc: string | null;
  venueManual: string | null;
  shoulderPainPre010Manual: number | null;
  shoulderPainPost010Manual: number | null;
};

export type ProgressionSet = {
  sessionId: string;
  exercise: string;
  weightKgReported: number | null;
  reps: number | null;
  effortRaw: string | null;
  setTypeManual: string | null;
  loadBasisManual: string | null;
  pain010Manual: number | null;
  venueManual: string | null;
};

export type ProgressionProposal = {
  phaseId: string;
  slotId: string;
  exercise: string;
  sourceSessionIds: [string, string];
  currentWeightKg: number;
  suggestedWeightKg: number | null;
  suggestedRangeKg: { minimum: number; maximum: number };
  evidence: "rir" | "repetition_fallback";
};

export type ProgressionResult = {
  proposals: ProgressionProposal[];
  blocked: Array<{
    slotId: string;
    reason:
      | "recent_non_normal_session"
      | "insufficient_comparable_sessions"
      | "pain_or_constraint"
      | "missing_or_ambiguous_data"
      | "target_not_met"
      | "unsupported_load";
  }>;
};

export function trainingProgressionFingerprint({
  phase,
  trainingBlockId,
  sessions,
  sets,
  constrainedExercises = [],
}: {
  phase: CyclePhase;
  trainingBlockId: string;
  sessions: ProgressionSession[];
  sets: ProgressionSet[];
  constrainedExercises?: string[];
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        trainingBlockId,
        phase,
        sessions: [...sessions]
          .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
          .map((session) => ({
            sessionId: session.sessionId,
            trainingPhaseId: session.trainingPhaseId,
            trainingBlockId: session.trainingBlockId,
            sessionIntent: session.sessionIntent,
            startedAt: session.startedAt,
            startedAtUtc: session.startedAtUtc,
            venueManual: session.venueManual,
            shoulderPainPre010Manual: session.shoulderPainPre010Manual,
            shoulderPainPost010Manual: session.shoulderPainPost010Manual,
          })),
        sets: [...sets]
          .sort((left, right) =>
            `${left.sessionId}|${left.exercise}|${left.weightKgReported}|${left.reps}|${left.effortRaw}`.localeCompare(
              `${right.sessionId}|${right.exercise}|${right.weightKgReported}|${right.reps}|${right.effortRaw}`,
            ),
          )
          .map((set) => ({
            sessionId: set.sessionId,
            exercise: set.exercise,
            weightKgReported: set.weightKgReported,
            reps: set.reps,
            effortRaw: set.effortRaw,
            setTypeManual: set.setTypeManual,
            loadBasisManual: set.loadBasisManual,
            pain010Manual: set.pain010Manual,
            venueManual: set.venueManual,
          })),
        constrainedExercises: [...constrainedExercises]
          .map(canonicalExerciseIdentity)
          .sort(),
      }),
      "utf8",
    )
    .digest("hex");
}

type RepRange = { minimum: number; maximum: number };

function repRange(value: string | undefined): RepRange | null {
  if (!value) return null;
  const match = value.trim().match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
  if (!match) return null;
  const minimum = Number(match[1]);
  const maximum = Number(match[2] ?? match[1]);
  if (minimum < 1 || maximum < minimum) return null;
  return { minimum, maximum };
}

function targetRir(value: string | undefined) {
  if (!value) return null;
  const match = value.match(/RIR\s*(\d+(?:\.\d+)?)/i);
  return match ? Number(match[1]) : null;
}

function actualRir(value: string | null) {
  if (!value) return null;
  const match = value.match(/RIR\s*(\d+(?:\.\d+)?)/i);
  if (match) return Number(match[1]);
  return /^\d+(?:\.\d+)?$/.test(value.trim())
    ? Number(value.trim())
    : null;
}

function isWarmup(set: ProgressionSet) {
  return /warm[ -]?up|熱身/i.test(set.setTypeManual ?? "");
}

function workingSets(sets: ProgressionSet[]) {
  const explicit = sets.filter((set) =>
    /work(ing)?|工作|正式/i.test(set.setTypeManual ?? ""),
  );
  return explicit.length > 0 ? explicit : sets.filter((set) => !isWarmup(set));
}

function modeWeight(sets: ProgressionSet[]) {
  const counts = new Map<number, number>();
  for (const set of sets) {
    if (set.weightKgReported === null) continue;
    counts.set(
      set.weightKgReported,
      (counts.get(set.weightKgReported) ?? 0) + 1,
    );
  }
  return [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || right[0] - left[0],
  )[0]?.[0] ?? null;
}

function normalizedMetadata(value: string | null) {
  return value?.trim().toLowerCase().replace(/[\s_-]+/g, "") || null;
}

function comparableEquipment(
  leftSession: ProgressionSession,
  leftSets: ProgressionSet[],
  rightSession: ProgressionSession,
  rightSets: ProgressionSet[],
) {
  const leftBases = new Set(
    leftSets.map((set) => normalizedMetadata(set.loadBasisManual)).filter(Boolean),
  );
  const rightBases = new Set(
    rightSets.map((set) => normalizedMetadata(set.loadBasisManual)).filter(Boolean),
  );
  if (leftBases.size > 0 && rightBases.size > 0) {
    return [...leftBases].some((value) => rightBases.has(value));
  }
  const leftVenue = normalizedMetadata(
    leftSession.venueManual ?? leftSets.find((set) => set.venueManual)?.venueManual ?? null,
  );
  const rightVenue = normalizedMetadata(
    rightSession.venueManual ?? rightSets.find((set) => set.venueManual)?.venueManual ?? null,
  );
  return !leftVenue || !rightVenue || leftVenue === rightVenue;
}

function rounded(value: number) {
  return Math.round(value * 100) / 100;
}

function loadSuggestion(current: number, increment: number | undefined) {
  const minimum = rounded(current * 1.02);
  const maximum = rounded(current * 1.1);
  if (!increment) {
    return { minimum, maximum, exact: null };
  }
  const steps = Math.max(1, Math.ceil((minimum - current) / increment));
  const candidate = rounded(current + steps * increment);
  return {
    minimum,
    maximum,
    exact: candidate <= maximum ? candidate : null,
  };
}

function phaseSets(
  sets: ProgressionSet[],
  slot: TrainingRoutineSlotConfig,
) {
  const allowed = new Set(
    [slot.preferredExercise, ...slot.alternatives].map(
      canonicalExerciseIdentity,
    ),
  );
  return sets.filter((set) => allowed.has(canonicalExerciseIdentity(set.exercise)));
}

function sessionHasPain(session: ProgressionSession, sets: ProgressionSet[]) {
  return (
    (session.shoulderPainPre010Manual ?? 0) > 0 ||
    (session.shoulderPainPost010Manual ?? 0) > 0 ||
    sets.some((set) => (set.pain010Manual ?? 0) > 0)
  );
}

function evidenceForSession(
  slot: TrainingRoutineSlotConfig,
  sets: ProgressionSet[],
) {
  const range = repRange(slot.targetReps);
  const rows = workingSets(sets);
  if (
    !range ||
    rows.length < (slot.targetSets ?? 1) ||
    rows.some((set) => set.reps === null)
  ) {
    return null;
  }
  const rirTarget = targetRir(slot.targetEffort);
  const observedRir = rows.map((set) => actualRir(set.effortRaw));
  const hasAnyRir = observedRir.some((value) => value !== null);
  if (hasAnyRir) {
    if (
      rirTarget === null ||
      observedRir.some((value) => value === null || value < rirTarget) ||
      rows.some((set) => set.reps! < range.maximum)
    ) {
      return null;
    }
    return "rir" as const;
  }
  const lastReps = rows.at(-1)!.reps!;
  if (
    rows.some((set) => set.reps! < range.minimum) ||
    lastReps < range.maximum + 1 ||
    lastReps > range.maximum + 2
  ) {
    return null;
  }
  return "repetition_fallback" as const;
}

export function evaluateTrainingProgression({
  phase,
  trainingBlockId,
  sessions,
  sets,
  constrainedExercises = [],
}: {
  phase: CyclePhase;
  trainingBlockId: string;
  sessions: ProgressionSession[];
  sets: ProgressionSet[];
  constrainedExercises?: string[];
}): ProgressionResult {
  const phaseSessions = sessions
    .filter(
      (session) =>
        session.trainingPhaseId === phase.id &&
        session.trainingBlockId === trainingBlockId,
    )
    .sort((left, right) =>
      `${right.startedAtUtc ?? right.startedAt}|${right.sessionId}`.localeCompare(
        `${left.startedAtUtc ?? left.startedAt}|${left.sessionId}`,
      ),
    );
  const normalSessions = phaseSessions.filter(
    (session) => session.sessionIntent === "normal",
  );
  const setsBySession = new Map<string, ProgressionSet[]>();
  for (const set of sets) {
    const rows = setsBySession.get(set.sessionId) ?? [];
    rows.push(set);
    setsBySession.set(set.sessionId, rows);
  }
  const constrained = new Set(
    constrainedExercises.map(canonicalExerciseIdentity),
  );
  const proposals: ProgressionProposal[] = [];
  const blocked: ProgressionResult["blocked"] = [];

  for (const slot of phase.routine ?? []) {
    if (phaseSessions[0]?.sessionIntent !== "normal") {
      blocked.push({ slotId: slot.id, reason: "recent_non_normal_session" });
      continue;
    }
    const comparable = normalSessions.flatMap((session) => {
      const rows = phaseSets(setsBySession.get(session.sessionId) ?? [], slot);
      return rows.length > 0 ? [{ session, rows }] : [];
    });
    if (comparable.length < 2) {
      blocked.push({
        slotId: slot.id,
        reason: "insufficient_comparable_sessions",
      });
      continue;
    }
    const latest = comparable[0];
    const exerciseIdentity = canonicalExerciseIdentity(latest.rows[0].exercise);
    const previous = comparable.slice(1).find(
      (candidate) =>
        canonicalExerciseIdentity(candidate.rows[0].exercise) === exerciseIdentity,
    );
    if (!previous) {
      blocked.push({
        slotId: slot.id,
        reason: "insufficient_comparable_sessions",
      });
      continue;
    }
    if (
      constrained.has(exerciseIdentity) ||
      sessionHasPain(latest.session, latest.rows) ||
      sessionHasPain(previous.session, previous.rows)
    ) {
      blocked.push({ slotId: slot.id, reason: "pain_or_constraint" });
      continue;
    }
    if (
      !comparableEquipment(
        latest.session,
        latest.rows,
        previous.session,
        previous.rows,
      )
    ) {
      blocked.push({
        slotId: slot.id,
        reason: "missing_or_ambiguous_data",
      });
      continue;
    }
    const latestEvidence = evidenceForSession(slot, latest.rows);
    const previousEvidence = evidenceForSession(slot, previous.rows);
    if (!latestEvidence || !previousEvidence || latestEvidence !== previousEvidence) {
      blocked.push({ slotId: slot.id, reason: "target_not_met" });
      continue;
    }
    const currentWeight = modeWeight(workingSets(latest.rows));
    const previousWeight = modeWeight(workingSets(previous.rows));
    if (
      currentWeight === null ||
      currentWeight <= 0 ||
      previousWeight !== currentWeight
    ) {
      blocked.push({ slotId: slot.id, reason: "unsupported_load" });
      continue;
    }
    const suggestion = loadSuggestion(currentWeight, slot.loadIncrementKg);
    proposals.push({
      phaseId: phase.id,
      slotId: slot.id,
      exercise: latest.rows[0].exercise,
      sourceSessionIds: [previous.session.sessionId, latest.session.sessionId],
      currentWeightKg: currentWeight,
      suggestedWeightKg: suggestion.exact,
      suggestedRangeKg: {
        minimum: suggestion.minimum,
        maximum: suggestion.maximum,
      },
      evidence: latestEvidence,
    });
  }

  return { proposals, blocked };
}
