import {
  planCategory,
  type TrainingCycleConfig,
} from "./training-cycle.ts";

export type ExerciseSuggestionSource =
  | "routine"
  | "selection"
  | "history";

export type ExerciseSuggestion = {
  exercise: string;
  sources: ExerciseSuggestionSource[];
  lastUsedAt: string | null;
  relevance: "same_slot" | "same_phase" | "same_category" | "other";
};

type SelectionCandidate = {
  exercise: string;
  recordedAt: string;
  phaseId?: string | null;
  slotId?: string | null;
};

type HistoryCandidate = {
  exercise: string;
  usedAt: string;
  phaseId?: string | null;
  sessionId?: string;
};

type RankedSuggestion = ExerciseSuggestion & {
  rankingFirstSeen: number;
  rankingHistorySessions: Set<string>;
  rankingLastUsedAt: string | null;
  rankingSourceRank: number;
  relevanceRank: number;
};

const SOURCE_ORDER: ExerciseSuggestionSource[] = [
  "routine",
  "selection",
  "history",
];

function timestampRank(value: string | null) {
  if (!value) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

export function canonicalExerciseUsedAt(
  startedAtUtc: string | null,
  startedAt: string,
) {
  for (const candidate of [startedAtUtc, startedAt]) {
    if (!candidate) continue;
    const timestamp = Date.parse(candidate);
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return startedAt;
}

export function exerciseSuggestionIdentity(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function buildExerciseSuggestions({
  config,
  selections,
  history,
  targetPhaseId = null,
  targetSlotId = null,
  query = "",
  limit = 200,
}: {
  config: TrainingCycleConfig;
  selections: readonly SelectionCandidate[];
  history: readonly HistoryCandidate[];
  targetPhaseId?: string | null;
  targetSlotId?: string | null;
  query?: string;
  limit?: number;
}): ExerciseSuggestion[] {
  const suggestions = new Map<string, RankedSuggestion>();
  const targetPhase = config.phases.find(
    (phase) => phase.id === targetPhaseId,
  );
  const targetCategory = targetPhase
    ? planCategory(targetPhase.label)
    : "unknown";
  const comparableCategory =
    targetCategory === "leg" ||
    targetCategory === "push" ||
    targetCategory === "pull"
      ? targetCategory
      : null;
  const phaseCategories = new Map(
    config.phases.map((phase) => [phase.id, planCategory(phase.label)]),
  );
  let originSequence = 0;

  function candidateRelevance(phaseId: string | null, slotId: string | null) {
    if (targetPhaseId && phaseId === targetPhaseId) {
      return targetSlotId && slotId === targetSlotId ? 0 : 1;
    }
    if (
      comparableCategory &&
      phaseId &&
      phaseCategories.get(phaseId) === comparableCategory
    ) {
      return 2;
    }
    return 3;
  }

  function add(
    exercise: string,
    source: ExerciseSuggestionSource,
    usedAt: string | null,
    phaseId: string | null,
    slotId: string | null,
    historySessionId: string | null = null,
  ) {
    const trimmed = exercise.trim();
    const identity = exerciseSuggestionIdentity(trimmed);
    if (!identity || trimmed.length > 120) return;
    const existing = suggestions.get(identity);
    const relevanceRank = candidateRelevance(phaseId, slotId);
    const sourceRank = SOURCE_ORDER.indexOf(source);
    const rankingHistorySessions = new Set<string>();
    if (source === "history" && historySessionId) {
      rankingHistorySessions.add(historySessionId);
    }
    const rankingFirstSeen = originSequence++;
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      existing.sources.sort(
        (left, right) =>
          SOURCE_ORDER.indexOf(left) - SOURCE_ORDER.indexOf(right),
      );
      if (
        usedAt &&
        (!existing.lastUsedAt ||
          timestampRank(usedAt) > timestampRank(existing.lastUsedAt))
      ) {
        existing.lastUsedAt = usedAt;
      }
      if (relevanceRank < existing.relevanceRank) {
        existing.relevanceRank = relevanceRank;
        existing.rankingFirstSeen = rankingFirstSeen;
        existing.rankingHistorySessions = rankingHistorySessions;
        existing.rankingLastUsedAt = usedAt;
        existing.rankingSourceRank = sourceRank;
      } else if (relevanceRank === existing.relevanceRank) {
        existing.rankingSourceRank = Math.min(
          existing.rankingSourceRank,
          sourceRank,
        );
        if (
          usedAt &&
          (!existing.rankingLastUsedAt ||
            timestampRank(usedAt) >
              timestampRank(existing.rankingLastUsedAt))
        ) {
          existing.rankingLastUsedAt = usedAt;
        }
        for (const sessionId of rankingHistorySessions) {
          existing.rankingHistorySessions.add(sessionId);
        }
      }
      return;
    }
    suggestions.set(identity, {
      exercise: trimmed,
      sources: [source],
      lastUsedAt: usedAt,
      relevance: "other",
      rankingFirstSeen,
      rankingHistorySessions,
      rankingLastUsedAt: usedAt,
      rankingSourceRank: sourceRank,
      relevanceRank,
    });
  }

  for (const phase of config.phases) {
    for (const slot of phase.routine ?? []) {
      add(slot.preferredExercise, "routine", null, phase.id, slot.id);
      for (const alternative of slot.alternatives) {
        add(alternative, "routine", null, phase.id, slot.id);
      }
    }
  }
  for (const selection of selections) {
    add(
      selection.exercise,
      "selection",
      selection.recordedAt,
      selection.phaseId ?? null,
      selection.slotId ?? null,
    );
  }
  for (const set of history) {
    add(
      set.exercise,
      "history",
      set.usedAt,
      set.phaseId ?? null,
      null,
      set.sessionId ?? null,
    );
  }

  const search = exerciseSuggestionIdentity(query);
  return [...suggestions.values()]
    .filter(
      (suggestion) =>
        !search || exerciseSuggestionIdentity(suggestion.exercise).includes(search),
    )
    .sort((left, right) => {
      if (search) {
        const leftIdentity = exerciseSuggestionIdentity(left.exercise);
        const rightIdentity = exerciseSuggestionIdentity(right.exercise);
        const leftExact = leftIdentity === search;
        const rightExact = rightIdentity === search;
        if (leftExact !== rightExact) return Number(rightExact) - Number(leftExact);
        const leftPrefix = leftIdentity.startsWith(search);
        const rightPrefix = rightIdentity.startsWith(search);
        if (leftPrefix !== rightPrefix) {
          return Number(rightPrefix) - Number(leftPrefix);
        }
      }
      if (left.relevanceRank !== right.relevanceRank) {
        return left.relevanceRank - right.relevanceRank;
      }
      if (left.rankingSourceRank !== right.rankingSourceRank) {
        return left.rankingSourceRank - right.rankingSourceRank;
      }
      if (left.rankingSourceRank === 0 && right.rankingSourceRank === 0) {
        return left.rankingFirstSeen - right.rankingFirstSeen;
      }
      const leftRecency = timestampRank(left.rankingLastUsedAt);
      const rightRecency = timestampRank(right.rankingLastUsedAt);
      if (leftRecency !== rightRecency) {
        return rightRecency > leftRecency ? 1 : -1;
      }
      const lexicalRecency = (right.rankingLastUsedAt ?? "").localeCompare(
        left.rankingLastUsedAt ?? "",
      );
      if (lexicalRecency !== 0) return lexicalRecency;
      if (
        left.rankingHistorySessions.size !==
        right.rankingHistorySessions.size
      ) {
        return (
          right.rankingHistorySessions.size -
          left.rankingHistorySessions.size
        );
      }
      return left.exercise.localeCompare(right.exercise);
    })
    .slice(0, Math.min(200, Math.max(1, Math.trunc(limit))))
    .map(({ exercise, sources, lastUsedAt, relevanceRank }) => ({
      exercise,
      sources,
      lastUsedAt,
      relevance:
        relevanceRank === 0
          ? "same_slot"
          : relevanceRank === 1
            ? "same_phase"
            : relevanceRank === 2
              ? "same_category"
              : "other",
    }));
}
