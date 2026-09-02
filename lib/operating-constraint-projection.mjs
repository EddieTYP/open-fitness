export const OPERATING_CONSTRAINT_CORRECTION_SCOPE = "operating_constraint";
export const OPERATING_CONSTRAINT_CORRECTION_FIELD = "status";
export const OPERATING_CONSTRAINT_STATUSES = [
  "Paused",
  "Conditional",
  "Resolved",
];

export function normaliseOperatingConstraintStatus(value) {
  if (typeof value !== "string") return null;
  const normalised = value.trim().toLowerCase();
  return (
    OPERATING_CONSTRAINT_STATUSES.find(
      (status) => status.toLowerCase() === normalised,
    ) ?? null
  );
}

function compareCorrections(left, right) {
  const effectiveDateOrder = right.effectiveDate.localeCompare(
    left.effectiveDate,
  );
  if (effectiveDateOrder !== 0) return effectiveDateOrder;
  const leftInstant = Date.parse(left.recordedAt);
  const rightInstant = Date.parse(right.recordedAt);
  if (Number.isFinite(leftInstant) || Number.isFinite(rightInstant)) {
    if (!Number.isFinite(leftInstant)) return 1;
    if (!Number.isFinite(rightInstant)) return -1;
    if (leftInstant !== rightInstant) return rightInstant - leftInstant;
  } else {
    const recordedAtOrder = right.recordedAt.localeCompare(left.recordedAt);
    if (recordedAtOrder !== 0) return recordedAtOrder;
  }
  return right.correctionId.localeCompare(left.correctionId);
}

/**
 * @template {{ constraintId: string, status: string, effectiveDate: string }} Constraint
 * @template {{ correctionId: string, effectiveDate: string, targetScope: string, targetKey: string, fieldName: string, correctedValue: string | null, recordedAt: string }} Correction
 * @param {readonly Constraint[]} constraints
 * @param {readonly Correction[]} correctionRows
 * @param {string} asOfDate
 * @returns {{ constraints: Constraint[], appliedCorrections: Correction[] }}
 */
export function projectOperatingConstraintCorrections(
  constraints,
  correctionRows,
  asOfDate,
) {
  /** @type {Map<string, Correction>} */
  const latestByConstraint = new Map();
  const applicableCorrections = correctionRows
    .filter(
      (correction) =>
        correction.targetScope === OPERATING_CONSTRAINT_CORRECTION_SCOPE &&
        correction.fieldName === OPERATING_CONSTRAINT_CORRECTION_FIELD &&
        correction.effectiveDate <= asOfDate &&
        normaliseOperatingConstraintStatus(correction.correctedValue) !== null,
    )
    .sort(compareCorrections);

  for (const correction of applicableCorrections) {
    if (!latestByConstraint.has(correction.targetKey)) {
      latestByConstraint.set(correction.targetKey, correction);
    }
  }

  /** @type {Correction[]} */
  const appliedCorrections = [];
  const projected = constraints
    .filter((constraint) => constraint.effectiveDate <= asOfDate)
    .map((constraint) => {
      const correction = latestByConstraint.get(constraint.constraintId);
      const status = normaliseOperatingConstraintStatus(
        correction?.correctedValue,
      );
      if (!correction || !status) return { ...constraint };
      appliedCorrections.push(correction);
      return { ...constraint, status };
    });

  return { constraints: projected, appliedCorrections };
}
