const genericConstraintWords = new Set([
  "exercise",
  "exercises",
  "light",
  "movement",
  "movements",
]);

function normalizedText(value: string) {
  return value.normalize("NFKC").toLowerCase().trim();
}

function tokens(value: string) {
  return normalizedText(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function tokenMatches(left: string, right: string) {
  return left === right || left.startsWith(right) || right.startsWith(left);
}

export function exerciseMatchesConstraintItem(
  exercise: string,
  constraintItem: string,
) {
  const normalizedExercise = normalizedText(exercise);
  const exerciseTokens = tokens(exercise);
  return constraintItem
    .split(/\s*(?:\/|\||\bor\b)\s*/i)
    .map((candidate) => normalizedText(candidate))
    .filter(Boolean)
    .some((candidate) => {
      if (
        normalizedExercise.includes(candidate) ||
        candidate.includes(normalizedExercise)
      ) {
        return true;
      }
      const candidateTokens = tokens(candidate).filter(
        (token) => !genericConstraintWords.has(token),
      );
      return (
        candidateTokens.length > 0 &&
        candidateTokens.every((candidateToken) =>
          exerciseTokens.some((exerciseToken) =>
            tokenMatches(candidateToken, exerciseToken),
          ),
        )
      );
    });
}

type ExerciseConstraint = {
  item: string;
  status: string;
  operatingRule: string;
};

export function exerciseConstraintState<T extends ExerciseConstraint>(
  exercise: string,
  constraints: T[],
) {
  const matching = constraints.filter((constraint) =>
    exerciseMatchesConstraintItem(exercise, constraint.item),
  );
  // Imported data can use descriptive active states such as
  // "Allowed if symptom-free". Treat every matching constraint as active until
  // it has been explicitly resolved, rather than silently dropping unfamiliar
  // status wording.
  const warningConstraints = matching.filter(
    (constraint) => constraint.status.trim().toLowerCase() !== "resolved",
  );
  const paused = warningConstraints.some((constraint) =>
    constraint.status.toLowerCase().includes("paused"),
  );
  return {
    matching,
    paused,
    conditional: !paused && warningConstraints.length > 0,
    rules: [
      ...new Set(
        warningConstraints.map((constraint) => constraint.operatingRule),
      ),
    ],
  };
}
