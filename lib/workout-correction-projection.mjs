/**
 * @typedef {{
 *   correctionId: string,
 *   targetScope: string,
 *   targetKey: string,
 *   fieldName: string,
 *   correctedValue: string | null,
 *   recordedAt: string,
 * }} Correction
 */

/**
 * @template {{ sessionId: string, sessionTitle: string }} Session
 * @template {{ setId: string, exercise: string, sessionId?: string }} Set
 * @template {Correction} CorrectionRow
 * @param {{ sessions?: readonly Session[], sets?: readonly Set[] }} records
 * @param {readonly CorrectionRow[]} corrections
 * @returns {{ sessions: Session[], sets: Set[], appliedCorrections: CorrectionRow[] }}
 */
export function projectWorkoutCorrections(
  { sessions = [], sets = [] },
  corrections,
) {
  const parsedInstant = (value) => {
    if (typeof value !== "string") return null;
    const instant = Date.parse(value);
    return Number.isFinite(instant) ? instant : null;
  };
  const compareCorrections = (left, right) => {
    const leftInstant = parsedInstant(left.recordedAt);
    const rightInstant = parsedInstant(right.recordedAt);
    if (leftInstant !== null || rightInstant !== null) {
      if (leftInstant === null) return 1;
      if (rightInstant === null) return -1;
      if (leftInstant !== rightInstant) return rightInstant - leftInstant;
    } else {
      const recordedAtOrder = String(right.recordedAt ?? "").localeCompare(
        String(left.recordedAt ?? ""),
      );
      if (recordedAtOrder !== 0) return recordedAtOrder;
    }
    return right.correctionId.localeCompare(left.correctionId);
  };

  /** @type {Map<string, CorrectionRow>} */
  const latest = new Map();
  for (const correction of [...corrections].sort(compareCorrections)) {
    const key = `${correction.targetScope}\0${correction.targetKey}\0${correction.fieldName}`;
    if (!latest.has(key)) latest.set(key, correction);
  }

  /** @type {CorrectionRow[]} */
  const appliedCorrections = [];
  const correctionFor = (scope, key, fieldName) =>
    latest.get(`${scope}\0${key}\0${fieldName}`) ?? null;

  const textValue = (correction) => {
    if (!correction || typeof correction.correctedValue !== "string") {
      return null;
    }
    const value = correction.correctedValue.trim();
    return value || null;
  };

  const nullableTextValue = (correction) => {
    if (!correction) return undefined;
    if (correction.correctedValue === null) return null;
    if (typeof correction.correctedValue !== "string") return undefined;
    const value = correction.correctedValue.trim();
    return value || undefined;
  };

  const nullableNumberValue = (correction, integer = false) => {
    if (!correction) return undefined;
    if (correction.correctedValue === null) return null;
    if (typeof correction.correctedValue !== "string") return undefined;
    const rawValue = correction.correctedValue.trim();
    if (!rawValue) return undefined;
    const value = Number(rawValue);
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1000 ||
      (integer && !Number.isInteger(value))
    ) {
      return undefined;
    }
    return value;
  };

  const markApplied = (correction) => {
    if (correction) appliedCorrections.push(correction);
  };

  const effectiveSessions = sessions.map((row) => {
    const titleCorrection = correctionFor(
      "workout_session",
      row.sessionId,
      "session_title",
    );
    const phaseCorrection = correctionFor(
      "workout_session",
      row.sessionId,
      "training_phase_id",
    );
    const sessionTitle = textValue(titleCorrection);
    const trainingPhaseId = nullableTextValue(phaseCorrection);
    const next = {
      ...row,
      ...(sessionTitle === null ? {} : { sessionTitle }),
      ...(trainingPhaseId === undefined ? {} : { trainingPhaseId }),
    };
    markApplied(titleCorrection && sessionTitle !== null ? titleCorrection : null);
    markApplied(phaseCorrection && trainingPhaseId !== undefined ? phaseCorrection : null);
    return next;
  });
  const effectiveSets = sets.map((row) => {
    const exerciseCorrection = correctionFor(
      "workout_set",
      row.setId,
      "exercise",
    );
    const repsCorrection = correctionFor("workout_set", row.setId, "reps");
    const weightCorrection = correctionFor(
      "workout_set",
      row.setId,
      "weight_kg_reported",
    );
    const effortCorrection = correctionFor(
      "workout_set",
      row.setId,
      "effort_raw",
    );
    const exercise = textValue(exerciseCorrection);
    const reps = nullableNumberValue(repsCorrection, true);
    const weightKgReported = nullableNumberValue(weightCorrection);
    const effortRaw = nullableTextValue(effortCorrection);
    const next = {
      ...row,
      ...(exercise === null ? {} : { exercise }),
      ...(reps === undefined ? {} : { reps }),
      ...(weightKgReported === undefined ? {} : { weightKgReported }),
      ...(effortRaw === undefined ? {} : { effortRaw }),
    };
    if (reps !== undefined || weightKgReported !== undefined) {
      const weight = next.weightKgReported ?? 0;
      const count = next.reps ?? 0;
      next.reportedLoadXRepsKg = Math.round(weight * count * 1000) / 1000;
    }
    markApplied(exerciseCorrection && exercise !== null ? exerciseCorrection : null);
    markApplied(repsCorrection && reps !== undefined ? repsCorrection : null);
    markApplied(weightCorrection && weightKgReported !== undefined ? weightCorrection : null);
    markApplied(effortCorrection && effortRaw !== undefined ? effortCorrection : null);
    return next;
  });

  const correctedLoadSetIds = new Set(
    appliedCorrections
      .filter(
        (correction) =>
          correction.targetScope === "workout_set" &&
          (correction.fieldName === "reps" ||
            correction.fieldName === "weight_kg_reported"),
      )
      .map((correction) => correction.targetKey),
  );
  const effectiveSessionsWithTotals = effectiveSessions.map((row) => {
    if (!("totalTvlKgReported" in row)) return row;
    const sessionSets = effectiveSets.filter(
      (set) => set.sessionId === row.sessionId,
    );
    if (
      sessionSets.length === 0 ||
      !sessionSets.some((set) => correctedLoadSetIds.has(set.setId))
    ) {
      return row;
    }
    const total = sessionSets.reduce(
      (sum, set) => sum + (Number(set.reportedLoadXRepsKg) || 0),
      0,
    );
    return {
      ...row,
      totalTvlKgReported: Math.round(total * 1000) / 1000,
    };
  });

  return {
    sessions: effectiveSessionsWithTotals,
    sets: effectiveSets,
    appliedCorrections,
  };
}
