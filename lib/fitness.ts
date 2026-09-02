import { and, asc, desc, eq, isNull, like, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  canonicalExerciseIdentity,
  exerciseText,
} from "@/lib/exercise-display";
import {
  bodyMeasurements,
  operatingConstraints,
  profile,
  sessionNotes,
  trainingBlocks,
  trainingExerciseSelections,
  trainingNextCourseOverrides,
  trainingPlannedSessions,
  trainingScheduleEvents,
  workoutSessions,
  workoutSets,
} from "@/db/schema";
import {
  inferNextCyclePhase,
  matchedCompletedTrainingPhase,
  parseCycle,
  parseStoredTrainingCycleConfig,
  planCategory,
  sessionMatchesCyclePhase,
  trainingAdjustmentFor,
  type CyclePhase,
  type PlanCategory,
  type TrainingAdjustment,
} from "@/lib/training-cycle";
import {
  effectiveExerciseSelection,
  historyExerciseSlotId,
  type TrainingSelectionRow,
} from "@/lib/training-selections";
import {
  deriveTrainingSchedule,
} from "@/lib/training-schedule";
import {
  classifyGoalType,
  type GoalType,
} from "@/lib/profile-settings";
import {
  DEFAULT_APP_LOCALE,
  isAppLocale,
  type AppLocale,
} from "@/lib/i18n/locales";
import {
  messageText,
  sourceText,
  type UiText,
} from "@/lib/i18n/ui-text";
import {
  exerciseConstraintState,
  exerciseMatchesConstraintItem,
} from "@/lib/training-constraints";
import { effectiveOperatingConstraints } from "@/lib/operating-constraint-corrections";
import {
  dateInTimeZone,
  DEFAULT_TIMEZONE,
  normaliseTimeZone,
} from "@/lib/timezone.mjs";
import { effectiveWorkoutRecords } from "@/lib/workout-corrections";
import { trainingCourseFingerprint } from "@/lib/training-course";

export type TrendPoint = {
  date: string;
  value: number;
};

export type DashboardMeasurement = {
  measuredAt: string;
  localDate: string;
  weightKg: number;
  bodyFatPct: number | null;
  muscleMassKg: number | null;
  bodyWaterPct: number | null;
  visceralFatRating: number | null;
};

export type DashboardSession = {
  sessionId: string;
  startedAt: string;
  startedAtUtc: string | null;
  localDate: string;
  title: string;
  type: string;
  durationMinutes: number;
  totalSets: number;
  totalVolumeKg: number | null;
  effort: string | null;
  averageHeartRateBpm: number | null;
};

export type SessionReview = {
  summary: UiText;
  overview: UiText | null;
  segments: Array<{
    sessionId: string;
    startedAt: string;
    startedAtUtc: string | null;
    timePrecision: string;
    durationMinutes: number;
    totalSets: number;
    venue: UiText;
  }>;
  sections: Array<{
    title: "completed" | "assessment" | "next";
    lines: UiText[];
  }>;
};

export type DashboardRecovery = {
  noteDate: string;
  area: string | null;
  note: string;
  pain010: number | null;
};

export type CourseItem = {
  phase: "warmup" | "primary" | "accessory" | "optional";
  exercise: UiText;
  prescription: UiText;
  loadGuidance: UiText;
  effort: UiText;
  detail: UiText[];
  notice?: UiText[];
  caution?: boolean;
  slotId?: string;
  phaseId?: string;
  exerciseKey?: string;
  preferredExercise?: string;
  alternatives?: string[];
  selectionSource?: "date" | "next" | "venue" | "template" | "history";
  overrideStatus?: "confirmed_next_normal";
};

export type TodayPlan = {
  decisionCode:
    | "ready"
    | "recover_first"
    | "reduce"
    | "recovery_day"
    | "baseline_required";
  adjustment: TrainingAdjustment;
  phaseKind: "training" | "recovery";
  sessionIntent: "normal" | "deload" | "test";
  phaseLabel: string;
  durationMinutes: { minimum: number; maximum: number } | null;
  confidence: "high" | "medium" | "low";
  briefing: UiText[];
  items: CourseItem[];
  referenceDate: string | null;
  referenceContext: UiText | null;
  phaseId: string | null;
  planningDate: string;
  venue: string | null;
  profileUpdatedAt: string | null;
  planFingerprint: string;
};

function withTrainingCourseFingerprint(
  plan: Omit<TodayPlan, "planFingerprint">,
): TodayPlan {
  return { ...plan, planFingerprint: trainingCourseFingerprint(plan) };
}

export type DashboardTrainingSchedule = {
  status: "active" | "paused";
  planningDate: string;
  cycle: CyclePhase[];
  nextPhase: CyclePhase | null;
  pause: {
    startsOn: string;
    resumeOn: string | null;
    reason: string | null;
  } | null;
};

export type ProgressMetric = {
  label: UiText;
  value: UiText;
  change: UiText;
  tone: "positive" | "neutral" | "watch";
};

export type ProgressSeries = {
  label: UiText;
  title: UiText;
  unit: "kg" | "minute";
  points: TrendPoint[];
  note: UiText;
};

export type ProgressData = {
  verdict: UiText;
  metrics: ProgressMetric[];
  series: {
    body: ProgressSeries;
    strength: ProgressSeries;
    cardio: ProgressSeries;
  };
  insights: UiText[];
};

export type FitnessGoalType = GoalType;

export type DashboardData = {
  status: "ready" | "empty" | "unavailable";
  profile: {
    displayName: string | null;
    primaryGoal: string;
    goalType: FitnessGoalType;
    timezone: string;
    preferredLocale: AppLocale;
    setupCompleted: boolean;
    currentTrainingBlock: {
      blockId: string;
      goalType: FitnessGoalType;
      primaryGoal: string;
      startsOn: string;
    } | null;
  } | null;
  latestMeasurement: DashboardMeasurement | null;
  latestStrength: DashboardSession | null;
  latestReview: SessionReview | null;
  latestCardio: DashboardSession | null;
  latestRecovery: DashboardRecovery | null;
  trainingSchedule: DashboardTrainingSchedule;
  todayPlan: TodayPlan | null;
  progress: ProgressData | null;
  dataCutoff: string | null;
  message: string | null;
};

type BodyRow = {
  measuredAt: string;
  localDate: string | null;
  weightKg: number;
  bodyFatPct: number | null;
  muscleMassKg: number | null;
};

type DailyBody = {
  date: string;
  weightKg: number;
  bodyFatPct: number | null;
  muscleMassKg: number | null;
};

type CardioDayRow = {
  date: string;
  state: "recorded_workout" | "explicit_none" | "no_record";
  sessions: number | null;
  minutes: number | null;
  correctionReason: string | null;
};

type ConstraintRow = typeof operatingConstraints.$inferSelect;
type SessionRow = typeof workoutSessions.$inferSelect;
type SetRow = typeof workoutSets.$inferSelect & { rawExercise?: string };
type NoteRow = typeof sessionNotes.$inferSelect;
type NextCourseOverrideRow = typeof trainingNextCourseOverrides.$inferSelect;
type PlannedSessionRow = typeof trainingPlannedSessions.$inferSelect;

function displayEffort(value: string) {
  const effort = value.trim();
  if (/^(rpe|rir)\b/i.test(effort)) {
    return effort.replace(/^rpe/i, "RPE").replace(/^rir/i, "RIR");
  }
  if (/^\d+(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?$/.test(effort)) {
    return `RPE ${effort}`;
  }
  return effort;
}

function recoveryRelevantToCategory(
  recovery: Pick<DashboardRecovery, "area" | "note"> | null,
  category: PlanCategory,
) {
  if (!recovery) return false;
  if (category === "recovery") return true;
  // A custom phase may not map to the built-in PPL body-area rules. In that
  // case it is safer to surface a recent recovery note than silently ignore it.
  if (category === "unknown" || category === "training") return true;
  const value = `${recovery.area ?? ""} ${recovery.note}`.toLowerCase();
  if (category === "leg") {
    return /腿|下肢|膝|髖|臀|小腿|hamstring|quad|calf|knee|hip/.test(
      value,
    );
  }
  if (category === "push") {
    return /肩|胸|三頭|上肢|手臂|肘|shoulder|chest|tricep|elbow/.test(
      value,
    );
  }
  return /肩|背|二頭|上肢|手臂|肘|shoulder|back|bicep|elbow/.test(
    value,
  );
}

function recoveryRelevantToPhase({
  recovery,
  phase,
  structured,
  sessions,
}: {
  recovery: NoteRow;
  phase: CyclePhase | null;
  structured: boolean;
  sessions: SessionRow[];
}) {
  if (!phase) return false;
  if (!structured) {
    return recoveryRelevantToCategory(
      { area: recovery.exerciseOrArea, note: recovery.note },
      phase.category,
    );
  }
  if (phase.kind === "recovery") return true;

  if (recovery.sessionId) {
    const linkedSession = sessions.find(
      (session) => session.sessionId === recovery.sessionId,
    );
    return Boolean(
      linkedSession &&
        sessionMatchesCyclePhase({
          phase,
          sessionTitle: linkedSession.sessionTitle,
          sessionType: linkedSession.sessionType,
          trainingPhaseId: linkedSession.trainingPhaseId,
        }),
    );
  }

  const scope = recovery.exerciseOrArea?.trim();
  if (!scope || !phase.routine?.length) return false;
  return phase.routine.some((slot) =>
    [slot.label, slot.preferredExercise, ...slot.alternatives].some((exercise) =>
      exerciseMatchesConstraintItem(exercise, scope),
    ),
  );
}

function toDashboardSession(row: SessionRow | undefined): DashboardSession | null {
  if (!row) return null;
  return {
    sessionId: row.sessionId,
    startedAt: row.startedAt,
    startedAtUtc: row.startedAtUtc,
    localDate: sessionLocalDate(row),
    title: row.sessionTitle,
    type: row.sessionType,
    durationMinutes: Math.round((row.durationSeconds / 60) * 10) / 10,
    totalSets: row.totalSetsReported,
    totalVolumeKg: row.totalTvlKgReported,
    effort: row.effortRaw,
    averageHeartRateBpm: row.averageHeartRateBpm,
  };
}

function reviewSessionsShareOccurrence(
  anchor: SessionRow,
  candidate: SessionRow,
) {
  return (
    anchor.trainingBlockId !== null &&
    anchor.trainingPhaseId !== null &&
    candidate.trainingBlockId === anchor.trainingBlockId &&
    candidate.trainingPhaseId === anchor.trainingPhaseId &&
    candidate.sessionIntent === anchor.sessionIntent &&
    sessionLocalDate(candidate) === sessionLocalDate(anchor)
  );
}

function reviewSessionGroup(sessions: SessionRow[], anchor: SessionRow) {
  if (!anchor.trainingBlockId || !anchor.trainingPhaseId) return [anchor];
  return sessions.filter((session) =>
    reviewSessionsShareOccurrence(anchor, session),
  );
}

function aggregateReviewSession(
  sessions: SessionRow[],
  title: string,
): SessionRow {
  const ordered = [...sessions].sort((left, right) =>
    (left.startedAtUtc ?? left.startedAt).localeCompare(
      right.startedAtUtc ?? right.startedAt,
    ),
  );
  const first = ordered[0];
  const last = ordered.at(-1)!;
  const sumOptional = (values: Array<number | null>) =>
    values.every((value): value is number => value !== null)
      ? values.reduce((total, value) => total + value, 0)
      : null;
  const efforts = new Set(
    sessions
      .map((session) => session.effortRaw?.trim())
      .filter((value): value is string => Boolean(value)),
  );

  return {
    ...last,
    sessionId: last.sessionId,
    sessionTitle: title,
    startedAt: first.startedAt,
    startedAtUtc: first.startedAtUtc,
    localDate: sessionLocalDate(first),
    endedAt: last.endedAt,
    durationSeconds: sessions.reduce(
      (total, session) => total + session.durationSeconds,
      0,
    ),
    totalSetsReported: sessions.reduce(
      (total, session) => total + session.totalSetsReported,
      0,
    ),
    burnedCaloriesKcalReported: sumOptional(
      sessions.map((session) => session.burnedCaloriesKcalReported),
    ),
    totalTvlKgReported: sumOptional(
      sessions.map((session) => session.totalTvlKgReported),
    ),
    effortRaw:
      efforts.size === 1 && sessions.every((session) => session.effortRaw)
        ? efforts.values().next().value ?? null
        : null,
    venueManual: null,
    activeCaloriesKcal: sumOptional(
      sessions.map((session) => session.activeCaloriesKcal),
    ),
    totalCaloriesKcal: sumOptional(
      sessions.map((session) => session.totalCaloriesKcal),
    ),
    averageHeartRateBpm: null,
  };
}

function sessionLocalDate(
  row: Pick<SessionRow, "localDate" | "startedAt">,
) {
  return row.localDate ?? row.startedAt.slice(0, 10);
}

function dayNumber(value: string) {
  return Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
}

function daysAgo(date: string, cutoff: string) {
  return Math.round((dayNumber(cutoff) - dayNumber(date)) / 86_400_000);
}

function mean(values: number[]) {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function signed(value: number, digits = 2) {
  const rounded = value.toFixed(digits);
  return value > 0 ? `+${rounded}` : rounded;
}

function aggregateDailyBody(rows: BodyRow[]): DailyBody[] {
  const daily = new Map<
    string,
    {
      weights: number[];
      bodyFat: number[];
      muscleMass: number[];
    }
  >();

  for (const row of rows) {
    if (!row.localDate) {
      throw new Error("Body measurement is missing its local calendar date");
    }
    const date = row.localDate;
    const current = daily.get(date) ?? {
      weights: [],
      bodyFat: [],
      muscleMass: [],
    };
    current.weights.push(row.weightKg);
    if (row.bodyFatPct !== null) current.bodyFat.push(row.bodyFatPct);
    if (row.muscleMassKg !== null) current.muscleMass.push(row.muscleMassKg);
    daily.set(date, current);
  }

  return [...daily.entries()]
    .map(([date, values]) => ({
      date,
      weightKg: mean(values.weights)!,
      bodyFatPct: mean(values.bodyFat),
      muscleMassKg: mean(values.muscleMass),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function windowValues(
  rows: DailyBody[],
  cutoff: string,
  startDaysAgo: number,
  endDaysAgo: number,
  field: "weightKg" | "bodyFatPct" | "muscleMassKg",
) {
  return rows
    .filter((row) => {
      const age = daysAgo(row.date, cutoff);
      return age >= startDaysAgo && age < endDaysAgo;
    })
    .map((row) => row[field])
    .filter((value): value is number => value !== null);
}

function rowsInWindow(rows: DailyBody[], cutoff: string, days: number) {
  return rows.filter((row) => {
    const age = daysAgo(row.date, cutoff);
    return age >= 0 && age < days;
  });
}

function windowSpanDays(rows: DailyBody[]) {
  if (rows.length < 2) return 0;
  return Math.round(
    (dayNumber(rows.at(-1)!.date) - dayNumber(rows[0].date)) / 86_400_000,
  );
}

function projectedTrend(
  rows: DailyBody[],
  field: "weightKg" | "muscleMassKg",
  days = 28,
) {
  const values = rows
    .map((row) => ({ date: row.date, value: row[field] }))
    .filter(
      (row): row is { date: string; value: number } => row.value !== null,
    );
  if (values.length < 2) return null;
  const origin = dayNumber(values[0].date);
  const points = values.map((row) => ({
    x: (dayNumber(row.date) - origin) / 86_400_000,
    y: row.value,
  }));
  const meanX = mean(points.map((point) => point.x))!;
  const meanY = mean(points.map((point) => point.y))!;
  const denominator = points.reduce(
    (total, point) => total + (point.x - meanX) ** 2,
    0,
  );
  if (denominator === 0) return null;
  const numerator = points.reduce(
    (total, point) =>
      total + (point.x - meanX) * (point.y - meanY),
    0,
  );
  return (numerator / denominator) * days;
}

type VenueResolution = {
  kind: "known" | "unknown" | "conflict";
  label: string | null;
};

function normalizeVenue(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s\-_/（）()]+/g, "");
}

function resolveVenueLabels(labels: Array<string | null | undefined>) {
  const distinct = new Map<string, string>();
  for (const label of labels) {
    const trimmed = label?.trim();
    if (!trimmed) continue;
    distinct.set(normalizeVenue(trimmed), trimmed);
  }
  if (distinct.size > 1) {
    return { kind: "conflict", label: null } satisfies VenueResolution;
  }
  const explicitVenue = distinct.values().next().value as string | undefined;
  if (explicitVenue) {
    return { kind: "known", label: explicitVenue } satisfies VenueResolution;
  }
  return { kind: "unknown", label: null } satisfies VenueResolution;
}

function resolveSessionVenue(
  session: SessionRow,
  notes: NoteRow[],
  sets: SetRow[] = [],
): VenueResolution {
  const sessionNotes = notes.filter(
    (note) => note.sessionId === session.sessionId,
  );
  const directVenue = resolveVenueLabels([
    session.venueManual,
    ...sets.map((set) => set.venueManual),
  ]);
  if (directVenue.kind !== "unknown") return directVenue;

  return resolveVenueLabels(sessionNotes.map((note) => note.venue));
}

function venuePresentation(label: string | null): UiText | null {
  if (!label) return null;
  const normalized = normalizeVenue(label);
  if (["慣常場館", "常去場館", "usualgym", "usualvenue"].includes(normalized)) {
    return messageText("fitness.venue.usual");
  }
  if (["非慣常場館", "othergym", "othervenue"].includes(normalized)) {
    return messageText("fitness.venue.other");
  }
  return sourceText(label);
}

function venueContext(session: SessionRow, notes: NoteRow[], sets: SetRow[] = []) {
  return venuePresentation(resolveSessionVenue(session, notes, sets).label);
}

function venuesConflict(left: VenueResolution, right: VenueResolution) {
  return (
    left.kind === "conflict" ||
    right.kind === "conflict" ||
    (left.kind === "known" &&
      right.kind === "known" &&
      normalizeVenue(left.label!) !== normalizeVenue(right.label!))
  );
}

function setExerciseNames(set: SetRow) {
  return [...new Set([set.exercise, set.rawExercise ?? set.exercise])];
}

function setMatchesExercise(set: SetRow, exercise: string) {
  const target = canonicalExerciseIdentity(exercise);
  return setExerciseNames(set).some(
    (candidate) => canonicalExerciseIdentity(candidate) === target,
  );
}

function setsShareExercise(left: SetRow, right: SetRow) {
  return setExerciseNames(left).some((exercise) =>
    setMatchesExercise(right, exercise),
  );
}

function exerciseSemanticText(exercise: string, sets: SetRow[] = []) {
  return [exercise, ...sets.flatMap(setExerciseNames)].join(" ").toLowerCase();
}

function exerciseConstraintStateForSets(
  exercise: string,
  sets: SetRow[],
  constraints: ConstraintRow[],
) {
  const states = [
    ...new Set([
      exercise,
      ...sets.flatMap((set) => [set.exercise, set.rawExercise ?? set.exercise]),
    ]),
  ].map((candidate) => exerciseConstraintState(candidate, constraints));
  return {
    paused: states.some((state) => state.paused),
    conditional: states.some((state) => state.conditional),
    rules: [...new Set(states.flatMap((state) => state.rules))],
  };
}

function historyCourseGroups(sets: SetRow[]) {
  const grouped = new Map<string, SetRow[]>();
  for (const set of sets) {
    const sourceSets = grouped.get(set.exercise) ?? [];
    sourceSets.push(set);
    grouped.set(set.exercise, sourceSets);
  }
  return [...grouped.entries()].map(([sourceExercise, sourceSets]) => ({
    sourceExercise,
    sourceSets,
    slot: {
      id: historyExerciseSlotId(sourceSets[0].setId),
      label: sourceExercise,
      preferredExercise: sourceExercise,
      alternatives: [],
    },
  }));
}

function modeWeight(rows: SetRow[]) {
  const counts = new Map<number, number>();
  for (const row of rows) {
    if (row.weightKgReported === null) continue;
    counts.set(
      row.weightKgReported,
      (counts.get(row.weightKgReported) ?? 0) + 1,
    );
  }
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || b[0] - a[0],
  )[0]?.[0] ?? null;
}

function isExplicitWarmup(row: SetRow) {
  return /warm[ -]?up|熱身/i.test(row.setTypeManual ?? "");
}

function isExplicitWorkingSet(row: SetRow) {
  return /work(ing)?|工作|正式/i.test(row.setTypeManual ?? "");
}

function planningSetRows(rows: SetRow[]) {
  const explicitWorking = rows.filter(isExplicitWorkingSet);
  if (explicitWorking.length > 0) return explicitWorking;
  return rows.filter((row) => !isExplicitWarmup(row));
}

function repeatedLoadSetCount(rows: SetRow[], workingWeight: number | null) {
  if (rows.length === 0) return 1;
  if (workingWeight === null) return rows.length;
  return rows.filter((row) => row.weightKgReported === workingWeight).length;
}

function sessionVenueMetadataIsConsistent(
  rows: SetRow[],
  session: SessionRow,
  notes: NoteRow[],
  planningVenue: string | null,
) {
  const sessionVenue = resolveSessionVenue(session, notes, rows);
  const requestedVenue: VenueResolution = planningVenue
    ? { kind: "known", label: planningVenue }
    : { kind: "unknown", label: null };
  return !venuesConflict(sessionVenue, requestedVenue);
}

function compactRepTarget(rows: SetRow[], workingWeight: number | null) {
  const relevant = rows.filter(
    (row) =>
      row.reps !== null &&
      (workingWeight === null || row.weightKgReported === workingWeight),
  );
  const reps = relevant.map((row) => row.reps!).sort((a, b) => a - b);
  if (reps.length === 0) return null;
  const middle = reps[Math.floor(reps.length / 2)];
  const low = Math.max(1, middle - (middle >= 10 ? 2 : 0));
  return low === middle ? `${middle}` : `${low}-${middle}`;
}

function displayLoadText(
  exercise: string,
  weight: number | null,
  sets: SetRow[] = [],
): UiText {
  const value = exerciseSemanticText(exercise, sets);
  if (
    value.includes("bodyweight") ||
    value.includes("pull-up") ||
    weight === 0
  ) {
    return messageText("fitness.plan.load.bodyweight");
  }
  if (weight === null) {
    return messageText("fitness.plan.load.lastControlled");
  }
  const formattedWeight = weight.toFixed(weight % 1 === 0 ? 0 : 2);
  return value.includes("dumbbell") || value.includes("single-arm")
    ? messageText("fitness.plan.load.kgPerHand", { weight: formattedWeight })
    : sourceText(`${formattedWeight} kg`);
}

function isCompoundExercise(exercise: string, sets: SetRow[] = []) {
  return /press|squat|deadlift|row|pull-up|pulldown/i.test(
    exerciseSemanticText(exercise, sets),
  );
}

function buildHistoryCourseItems({
  phase,
  sets,
  selections,
  planningDate,
  venue,
  constraints,
  reduced = false,
  exactLoadAllowed = true,
}: {
  phase: CyclePhase;
  sets: SetRow[];
  selections: TrainingSelectionRow[];
  planningDate: string;
  venue: string | null;
  constraints: ConstraintRow[];
  reduced?: boolean;
  exactLoadAllowed?: boolean;
}): CourseItem[] {
  const category = phase.category;

  const warmup: CourseItem = {
    phase: "warmup",
    exercise: messageText(
      category === "push"
        ? "fitness.plan.exercise.warmupPush"
        : category === "leg"
          ? "fitness.plan.exercise.warmupLeg"
          : category === "pull"
            ? "fitness.plan.exercise.warmupPull"
            : "fitness.plan.exercise.warmupGeneral",
    ),
    prescription: messageText("fitness.plan.duration.range", {
      minimum: 5,
      maximum: 7,
    }),
    loadGuidance: messageText("fitness.plan.load.lightToModerate"),
    effort: sourceText("RPE 2-3"),
    detail: [messageText("fitness.plan.detail.warmupCheck")],
  };

  const exercises = historyCourseGroups(sets)
    .map(({ sourceExercise, sourceSets, slot }) => {
      const selection = effectiveExerciseSelection({
        phaseId: phase.id,
        slot,
        date: planningDate,
        venue,
        selections,
        fallbackSource: "history",
      });
      const usesSourceHistory = sourceSets.some((set) =>
        setMatchesExercise(set, selection.exercise),
      );
      return {
        sourceExercise,
        sourceSets,
        slot,
        selection,
        exercise: selection.exercise,
        usesSourceHistory,
        semanticSets: usesSourceHistory ? sourceSets : [],
      };
    })
    .map(
      (
        {
          sourceExercise,
          sourceSets,
          slot,
          selection,
          exercise,
          usesSourceHistory,
          semanticSets,
        },
        index,
      ): CourseItem => {
        const planningRows = planningSetRows(sourceSets);
        const workingWeight = modeWeight(planningRows);
        const reps = compactRepTarget(planningRows, workingWeight);
        const constraintState = exerciseConstraintStateForSets(
          exercise,
          semanticSets,
          constraints,
        );
        const { paused, conditional } = constraintState;
        const machineOrCable = /machine|cable/i.test(
          exerciseSemanticText(exercise, semanticSets),
        );
        const repeatedCount = repeatedLoadSetCount(
          planningRows,
          workingWeight,
        );
        const recordedSetCount = Math.min(5, Math.max(1, repeatedCount));
        const unlabelledRamp =
          !planningRows.some(isExplicitWorkingSet) &&
          planningRows.length > 1 &&
          repeatedCount === 1;
        const setCount = reduced
          ? Math.max(1, recordedSetCount - 1)
          : recordedSetCount;
        const detail: UiText[] = paused
          ? []
          : [
              ...(usesSourceHistory
                ? []
                : [messageText("fitness.plan.detail.noComparableHistory")]),
              messageText(
                isCompoundExercise(exercise, semanticSets)
                  ? "fitness.plan.rest.twoMinutes"
                  : "fitness.plan.rest.sixtyToNinetySeconds",
              ),
              messageText(
                machineOrCable
                  ? "fitness.plan.detail.progressionMachine"
                  : "fitness.plan.detail.progressionStandard",
              ),
            ];
        const notice: UiText[] = [
          ...(paused
            ? [messageText("fitness.plan.detail.exercisePaused")]
            : []),
          ...constraintState.rules.map((operatingRule) =>
            messageText("fitness.plan.detail.authoredRule", {
              rule: operatingRule,
            }),
          ),
        ];
        if (!paused && unlabelledRamp) {
          detail.push(messageText("fitness.plan.detail.unlabelledRamp"));
        }
        if (!paused && usesSourceHistory && !exactLoadAllowed) {
          detail.push(messageText("fitness.plan.detail.loadReferenceOnly"));
        }

        return {
          phase: index < 2 ? "primary" : "accessory",
          exercise: exerciseText(exercise),
          prescription: selection.prescriptionOverride
            ? sourceText(selection.prescriptionOverride)
            : paused
            ? sourceText("-")
            : reps === null
              ? messageText("fitness.plan.prescription.timedSets", {
                  sets: setCount,
                })
              : sourceText(`${setCount} × ${reps}`),
          loadGuidance: selection.loadGuidanceOverride
            ? sourceText(selection.loadGuidanceOverride)
            : paused
            ? messageText("fitness.plan.load.paused")
            : reduced
            ? usesSourceHistory
              ? messageText("fitness.plan.load.lighterThanPrevious")
              : messageText("fitness.plan.load.testSetFirst")
            : !usesSourceHistory
              ? messageText("fitness.plan.load.testSetFirst")
              : unlabelledRamp || !exactLoadAllowed
              ? messageText("fitness.plan.load.chooseByRir")
              : displayLoadText(exercise, workingWeight, semanticSets),
          effort: selection.effortOverride
            ? sourceText(selection.effortOverride)
            : paused
            ? sourceText("-")
            : sourceText(
                reduced ? "RIR 4" : conditional ? "RIR 3" : "RIR 2-3",
              ),
          detail,
          notice,
          caution: paused || conditional,
          exerciseKey: exercise,
          phaseId: phase.id,
          slotId: slot.id,
          preferredExercise: sourceExercise,
          alternatives: [sourceExercise],
          selectionSource: selection.source,
        };
      },
    );

  const optionalCardio: CourseItem = {
    phase: "optional",
    exercise: messageText("fitness.plan.exercise.easyCardio"),
    prescription: messageText("fitness.plan.duration.range", {
      minimum: 10,
      maximum: 20,
    }),
    loadGuidance: messageText("fitness.plan.load.inclineOrStepper"),
    effort: sourceText("RPE 3-4"),
    detail: [messageText("fitness.plan.detail.optionalCardio")],
  };

  return [warmup, ...exercises, optionalCardio];
}

function buildConfiguredCourseItems({
  phase,
  sets,
  selections,
  nextOverrides,
  planningDate,
  venue,
  constraints,
  reduced,
  exactLoadAllowed,
}: {
  phase: CyclePhase;
  sets: SetRow[];
  selections: TrainingSelectionRow[];
  nextOverrides: NextCourseOverrideRow[];
  planningDate: string;
  venue: string | null;
  constraints: ConstraintRow[];
  reduced: boolean;
  exactLoadAllowed: boolean;
}): CourseItem[] {
  const warmup: CourseItem = {
    phase: "warmup",
    exercise: messageText("fitness.plan.exercise.dynamicWarmup"),
    prescription: messageText("fitness.plan.duration.range", { minimum: 5, maximum: 8 }),
    loadGuidance: messageText("fitness.plan.load.lightToModerate"),
    effort: sourceText("RPE 2-3"),
    detail: [messageText("fitness.plan.detail.dynamicWarmupCheck")],
  };
  const items = (phase.routine ?? []).map((slot, index): CourseItem => {
    const storedSelection = effectiveExerciseSelection({
      phaseId: phase.id,
      slot,
      date: planningDate,
      venue,
      selections,
    });
    const nextOverride =
      storedSelection.source === "date"
        ? null
        : nextOverrides.find(
            (override) =>
              override.phaseId === phase.id && override.slotId === slot.id,
          ) ?? null;
    const selection = nextOverride
      ? {
          exercise: nextOverride.exercise,
          source: "next" as const,
          prescriptionOverride: nextOverride.prescriptionOverride,
          loadGuidanceOverride: nextOverride.loadGuidanceOverride,
          effortOverride: nextOverride.effortOverride,
        }
      : storedSelection;
    const exerciseSets = sets.filter((set) =>
      setMatchesExercise(set, selection.exercise),
    );
    const planningRows = planningSetRows(exerciseSets);
    const workingWeight = modeWeight(planningRows);
    const historicalSetCount = Math.min(
      5,
      Math.max(1, repeatedLoadSetCount(planningRows, workingWeight)),
    );
    const setCount = slot.targetSets ?? historicalSetCount;
    const reps =
      slot.targetReps ??
      (planningRows.length > 0
        ? compactRepTarget(planningRows, workingWeight)
        : null);
    const constraintState = exerciseConstraintStateForSets(
      selection.exercise,
      exerciseSets,
      constraints,
    );
    const { paused, conditional } = constraintState;
    const hasExactHistory = planningRows.length > 0 && exactLoadAllowed;
    const sourceLabel: UiText =
      selection.source === "date"
        ? messageText("fitness.plan.source.today")
        : selection.source === "next"
          ? messageText("fitness.plan.source.confirmedNext")
        : selection.source === "venue"
          ? messageText("fitness.plan.source.venue", {
              venue: venue ?? "",
            })
          : messageText("fitness.plan.source.routine");
    const detailParts: UiText[] = [
      sourceLabel,
      ...(!paused
        ? [hasExactHistory
          ? messageText("fitness.plan.detail.sameExerciseHistory")
          : messageText("fitness.plan.detail.noComparableHistory")]
        : []),
    ];
    const notice: UiText[] = [
      ...(paused
        ? [messageText("fitness.plan.detail.exercisePaused")]
        : []),
      ...constraintState.rules.map((operatingRule) =>
        messageText("fitness.plan.detail.authoredRule", {
          rule: operatingRule,
        }),
      ),
    ];
    return {
      phase: index < 2 ? "primary" : "accessory",
      exercise: exerciseText(selection.exercise),
      prescription: selection.prescriptionOverride
        ? sourceText(selection.prescriptionOverride)
        : paused
        ? sourceText("-")
        : reps === null
          ? messageText("fitness.plan.prescription.configuredSets", {
              sets: reduced ? Math.max(1, setCount - 1) : setCount,
            })
          : sourceText(
              `${reduced ? Math.max(1, setCount - 1) : setCount} × ${reps}`,
            ),
      loadGuidance: selection.loadGuidanceOverride
        ? sourceText(selection.loadGuidanceOverride)
        : paused
        ? messageText("fitness.plan.load.paused")
        : reduced
          ? messageText("fitness.plan.load.lighterThanUsual")
          : hasExactHistory
            ? displayLoadText(selection.exercise, workingWeight, exerciseSets)
            : messageText("fitness.plan.load.testSetFirst"),
      effort: selection.effortOverride
        ? sourceText(selection.effortOverride)
        : paused
        ? sourceText("-")
        : reduced
          ? sourceText("RIR 4")
          : sourceText(slot.targetEffort ?? (conditional ? "RIR 3" : "RIR 2-3")),
      detail: detailParts,
      notice,
      caution: paused || conditional,
      slotId: slot.id,
      phaseId: phase.id,
      exerciseKey: selection.exercise,
      preferredExercise: slot.preferredExercise,
      alternatives: [slot.preferredExercise, ...slot.alternatives],
      selectionSource: selection.source,
      ...(selection.source === "next"
        ? { overrideStatus: "confirmed_next_normal" as const }
        : {}),
    };
  });
  return [warmup, ...items];
}

function reviewExerciseLine(rows: SetRow[]): UiText {
  const grouped = new Map<string, SetRow[]>();
  for (const row of rows) {
    const current = grouped.get(row.exercise) ?? [];
    current.push(row);
    grouped.set(row.exercise, current);
  }
  const first = grouped.entries().next().value as
    | [string, SetRow[]]
    | undefined;
  if (!first) return messageText("fitness.review.exercise.noSetData");
  const [exercise, exerciseRows] = first;
  const planningRows = planningSetRows(exerciseRows);
  const weight = modeWeight(planningRows);
  const matchingRows =
    weight === null
      ? planningRows
      : planningRows.filter((row) => row.weightKgReported === weight);
  const reps = matchingRows
    .map((row) => row.reps)
    .filter((value): value is number => value !== null);
  const value = exerciseSemanticText(exercise, exerciseRows);
  const isBodyweight =
    value.includes("bodyweight") || value.includes("pull-up") || weight === 0;
  const perHand = value.includes("dumbbell") || value.includes("single-arm");
  const recorded = reps.length > 0;
  const key = isBodyweight
    ? recorded
      ? "fitness.review.exercise.bodyweightRecorded"
      : "fitness.review.exercise.bodyweightMissing"
    : weight === null
      ? recorded
        ? "fitness.review.exercise.noLoadRecorded"
        : "fitness.review.exercise.noLoadMissing"
      : perHand
        ? recorded
          ? "fitness.review.exercise.kgPerHandRecorded"
          : "fitness.review.exercise.kgPerHandMissing"
        : recorded
          ? "fitness.review.exercise.kgRecorded"
          : "fitness.review.exercise.kgMissing";
  return messageText(key, {
    exercise: exerciseText(exercise),
    ...(weight === null || isBodyweight
      ? {}
      : { weight: weight.toFixed(weight % 1 === 0 ? 0 : 2) }),
    ...(reps.length > 0 ? { reps: reps.join(" / ") } : {}),
  });
}

function comparableExerciseLine(
  currentRows: SetRow[],
  previousRows: SetRow[],
  currentSession: SessionRow,
  previousSession: SessionRow | undefined,
  notes: NoteRow[],
): UiText {
  if (!previousSession || previousRows.length === 0) {
    return messageText("fitness.review.compare.noPrevious");
  }

  const sharedExercise = currentRows.find((current) =>
    previousRows.some((previous) => setsShareExercise(current, previous)),
  );
  if (!sharedExercise) {
    return messageText("fitness.review.compare.noSharedExercise");
  }
  const exercise = sharedExercise.exercise;

  const currentExerciseRows = planningSetRows(
    currentRows.filter((row) => setsShareExercise(row, sharedExercise)),
  );
  const previousExerciseRows = planningSetRows(
    previousRows.filter((row) => setsShareExercise(row, sharedExercise)),
  );
  const semantics = exerciseSemanticText(exercise, [
    ...currentExerciseRows,
    ...previousExerciseRows,
  ]);
  const isBodyweight = /bodyweight|pull-up/i.test(semantics);
  const currentVenue = resolveSessionVenue(
    currentSession,
    notes,
    currentExerciseRows,
  );
  const previousVenue = resolveSessionVenue(
    previousSession,
    notes,
    previousExerciseRows,
  );
  if (!isBodyweight && venuesConflict(currentVenue, previousVenue)) {
    return messageText("fitness.review.compare.venueMismatch");
  }

  if (isBodyweight) {
    if (
      currentExerciseRows.some((row) => row.reps === null) ||
      previousExerciseRows.some((row) => row.reps === null)
    ) {
      return messageText("fitness.review.compare.bodyweightMissingReps");
    }
    const currentReps = currentExerciseRows.reduce(
      (total, row) => total + row.reps!,
      0,
    );
    const previousReps = previousExerciseRows.reduce(
      (total, row) => total + row.reps!,
      0,
    );
    const difference = currentReps - previousReps;
    return messageText(
      difference === 0
        ? "fitness.review.compare.bodyweightSame"
        : difference > 0
          ? "fitness.review.compare.bodyweightMore"
          : "fitness.review.compare.bodyweightLess",
      {
        exercise: exerciseText(exercise),
        currentReps,
        difference: Math.abs(difference),
      },
    );
  }

  const currentWeight = modeWeight(currentExerciseRows);
  const previousWeight = modeWeight(previousExerciseRows);
  const currentLoadBases = new Set(
    currentExerciseRows
      .map((row) => row.loadBasisManual?.trim())
      .filter((value): value is string => Boolean(value)),
  );
  const previousLoadBases = new Set(
    previousExerciseRows
      .map((row) => row.loadBasisManual?.trim())
      .filter((value): value is string => Boolean(value)),
  );
  if (
    currentLoadBases.size > 0 &&
    previousLoadBases.size > 0 &&
    ![...currentLoadBases].some((value) => previousLoadBases.has(value))
  ) {
    return messageText("fitness.review.compare.loadBasisMismatch");
  }
  if (currentWeight === null || previousWeight === null) {
    return messageText("fitness.review.compare.missingLoad");
  }
  const currentComparableRows = currentExerciseRows.filter(
    (row) => row.weightKgReported === currentWeight,
  );
  const previousComparableRows = previousExerciseRows.filter(
    (row) => row.weightKgReported === previousWeight,
  );
  if (
    currentComparableRows.some((row) => row.reps === null) ||
    previousComparableRows.some((row) => row.reps === null)
  ) {
    return messageText("fitness.review.compare.missingReps");
  }
  const currentReps = currentComparableRows.reduce(
    (total, row) => total + row.reps!,
    0,
  );
  const previousReps = previousComparableRows.reduce(
    (total, row) => total + row.reps!,
    0,
  );
  if (currentWeight === previousWeight) {
    const difference = currentReps - previousReps;
    const perHand = /dumbbell|single-arm/i.test(semantics);
    return messageText(
      perHand
        ? difference === 0
          ? "fitness.review.compare.sameLoadPerHandSame"
          : difference > 0
            ? "fitness.review.compare.sameLoadPerHandMore"
            : "fitness.review.compare.sameLoadPerHandLess"
        : difference === 0
          ? "fitness.review.compare.sameLoadSame"
          : difference > 0
            ? "fitness.review.compare.sameLoadMore"
            : "fitness.review.compare.sameLoadLess",
      {
        exercise: exerciseText(exercise),
        weight: currentWeight.toFixed(currentWeight % 1 === 0 ? 0 : 2),
        difference: Math.abs(difference),
      },
    );
  }
  return messageText(
    /dumbbell|single-arm/i.test(semantics)
      ? "fitness.review.compare.loadChangedPerHand"
      : "fitness.review.compare.loadChanged",
    {
      exercise: exerciseText(exercise),
      previousWeight: previousWeight.toFixed(
        previousWeight % 1 === 0 ? 0 : 2,
      ),
      currentWeight: currentWeight.toFixed(currentWeight % 1 === 0 ? 0 : 2),
    },
  );
}

function buildSessionReview(
  session: SessionRow,
  rows: SetRow[],
  previousSession: SessionRow | undefined,
  previousRows: SetRow[],
  notes: NoteRow[],
  reviewSessions: SessionRow[] = [session],
): SessionReview {
  const exerciseCount = new Set(rows.map((row) => row.exercise)).size;
  const venue = resolveSessionVenue(session, notes, rows);
  const venueDisplay = venuePresentation(venue.label);
  const orderedReviewSessions = [...reviewSessions].sort((left, right) =>
    (left.startedAtUtc ?? left.startedAt).localeCompare(
      right.startedAtUtc ?? right.startedAt,
    ),
  );
  const segmentDetails = orderedReviewSessions.map((segment) => {
    const segmentRows = rows.filter((row) => row.sessionId === segment.sessionId);
    const segmentVenue = resolveSessionVenue(segment, notes, segmentRows);
    return {
      sessionId: segment.sessionId,
      startedAt: segment.startedAt,
      startedAtUtc: segment.startedAtUtc,
      timePrecision: segment.timePrecision,
      durationMinutes: Math.round((segment.durationSeconds / 60) * 10) / 10,
      totalSets: segment.totalSetsReported,
      venue:
        segmentVenue.kind === "known" && segmentVenue.label
          ? sourceText(segmentVenue.label)
          : messageText(
              segmentVenue.kind === "conflict"
                ? "fitness.review.segment.venueConflict"
                : "fitness.review.segment.venueUnknown",
            ),
      venueResolution: segmentVenue,
    };
  });
  const isMultiSession = segmentDetails.length > 1;
  const knownVenueLabels = new Set(
    segmentDetails
      .map((segment) => segment.venueResolution.label)
      .filter((label): label is string => Boolean(label))
      .map(normalizeVenue),
  );
  const allVenuesKnown = segmentDetails.every(
    (segment) => segment.venueResolution.kind === "known",
  );
  const effort =
    session.effortRaw && session.effortRaw.trim() !== "31"
      ? messageText("fitness.review.effort.reported", {
          effort: session.effortRaw,
        })
      : messageText("fitness.review.effort.unavailable");
  const volume =
    session.totalTvlKgReported === null
      ? messageText("fitness.review.volume.unavailable")
      : messageText("fitness.review.volume.value", {
          volume: (session.totalTvlKgReported / 1000).toFixed(1),
        });
  const venueNext = isMultiSession
    ? allVenuesKnown
      ? messageText("fitness.review.venue.knownNext")
      : messageText("fitness.review.venue.unknownNext")
    : venue.kind === "unknown"
      ? messageText("fitness.review.venue.unknownNext")
      : venue.kind === "conflict"
        ? messageText("fitness.review.venue.conflictNext")
        : messageText("fitness.review.venue.knownNext");

  return {
    summary: isMultiSession
      ? messageText("fitness.review.summary.multiSession", {
          exerciseCount,
          setCount: session.totalSetsReported,
        })
      : venue.kind === "unknown"
        ? messageText("fitness.review.summary.unknownVenue", { exerciseCount })
        : venue.kind === "conflict"
          ? messageText("fitness.review.summary.conflictingVenue", {
              exerciseCount,
            })
          : venueDisplay?.kind === "message" &&
              venueDisplay.key === "fitness.venue.usual"
            ? messageText("fitness.review.summary.usualVenue", {
                exerciseCount,
              })
            : venueDisplay?.kind === "message" &&
                venueDisplay.key === "fitness.venue.other"
              ? messageText("fitness.review.summary.otherVenue", {
                  exerciseCount,
                })
              : messageText("fitness.review.summary.knownVenue", {
                  exerciseCount,
                  venue: venue.label ?? "",
                }),
    overview: isMultiSession
      ? messageText(
          allVenuesKnown
            ? "fitness.review.multi.overview"
            : "fitness.review.multi.overviewPartialVenue",
          {
            minutes: Math.round(session.durationSeconds / 60),
            sessionCount: segmentDetails.length,
            venueCount: knownVenueLabels.size,
          },
        )
      : null,
    segments: isMultiSession
      ? segmentDetails.map((segment) => ({
          sessionId: segment.sessionId,
          startedAt: segment.startedAt,
          startedAtUtc: segment.startedAtUtc,
          timePrecision: segment.timePrecision,
          durationMinutes: segment.durationMinutes,
          totalSets: segment.totalSets,
          venue: segment.venue,
        }))
      : [],
    sections: [
      {
        title: "completed",
        lines: [
          messageText("fitness.review.completed.facts", {
            exerciseCount,
            setCount: session.totalSetsReported,
            minutes: Math.round(session.durationSeconds / 60),
          }),
          volume,
        ],
      },
      {
        title: "assessment",
        lines: [
          reviewExerciseLine(rows),
          comparableExerciseLine(
            rows,
            previousRows,
            session,
            previousSession,
            notes,
          ),
          effort,
        ],
      },
      {
        title: "next",
        lines: [
          venueNext,
          messageText("fitness.review.next.totalVolumeCaution"),
        ],
      },
    ],
  };
}

function buildRecoveryCourseItems(highPain: boolean): CourseItem[] {
  if (highPain) {
    return [
      {
        phase: "warmup",
        exercise: messageText("fitness.plan.exercise.statusCheck"),
        prescription: messageText("fitness.plan.duration.range", { minimum: 2, maximum: 3 }),
        loadGuidance: messageText("fitness.plan.load.noLoad"),
        effort: messageText("fitness.plan.effort.easy"),
        detail: [messageText("fitness.plan.detail.highPainCheck")],
        caution: true,
      },
      {
        phase: "primary",
        exercise: messageText("fitness.plan.exercise.painFreeActivity"),
        prescription: messageText("fitness.plan.duration.range", { minimum: 5, maximum: 15 }),
        loadGuidance: messageText("fitness.plan.load.walkingPreferred"),
        effort: sourceText("RPE 1-2"),
        detail: [messageText("fitness.plan.detail.stopIfSymptomsRise")],
        caution: true,
      },
      {
        phase: "accessory",
        exercise: messageText("fitness.plan.exercise.recoveryObservation"),
        prescription: messageText("fitness.plan.prescription.today"),
        loadGuidance: messageText("fitness.plan.load.recordResponse"),
        effort: sourceText("-"),
        detail: [messageText("fitness.plan.detail.seekAssessment")],
        caution: true,
      },
    ];
  }

  return [
    {
      phase: "warmup",
      exercise: messageText("fitness.plan.exercise.easyWalk"),
      prescription: messageText("fitness.plan.duration.minutes", { minutes: 5 }),
      loadGuidance: messageText("fitness.plan.load.flatGround"),
      effort: sourceText("RPE 2"),
      detail: [messageText("fitness.plan.detail.conversationPace")],
    },
    {
      phase: "primary",
      exercise: messageText("fitness.plan.exercise.lowIntensityCardio"),
      prescription: messageText("fitness.plan.duration.range", { minimum: 15, maximum: 25 }),
      loadGuidance: messageText("fitness.plan.load.walkOrBike"),
      effort: sourceText("RPE 2-3"),
      detail: [messageText("fitness.plan.detail.recoveryNotCalories")],
    },
    {
      phase: "accessory",
      exercise: messageText("fitness.plan.exercise.painFreeMobility"),
      prescription: messageText("fitness.plan.prescription.rounds", { rounds: 2 }),
      loadGuidance: messageText("fitness.plan.load.chooseExercises", { minimum: 2, maximum: 3 }),
      effort: messageText("fitness.plan.effort.easy"),
      detail: [messageText("fitness.plan.detail.comfortableRange")],
    },
  ];
}

function buildInsufficientCourseItems(category: PlanCategory): CourseItem[] {
  if (category === "training" || category === "unknown") {
    return [
      {
        phase: "warmup",
        exercise: messageText("fitness.plan.exercise.activityWarmup"),
        prescription: messageText("fitness.plan.duration.range", { minimum: 5, maximum: 10 }),
        loadGuidance: messageText("fitness.plan.load.startLight"),
        effort: sourceText("RPE 2-3"),
        detail: [messageText("fitness.plan.detail.noBaselineAssumptions")],
      },
      {
        phase: "primary",
        exercise: messageText("fitness.plan.exercise.followOriginalPlan"),
        prescription: messageText("fitness.plan.prescription.asPlanned"),
        loadGuidance: messageText("fitness.plan.load.noAutomaticEstimate"),
        effort: messageText("fitness.plan.effort.leaveReserve"),
        detail: [messageText("fitness.plan.detail.recordBaseline")],
        caution: true,
      },
    ];
  }
  return [
    {
      phase: "warmup",
      exercise: messageText(
        category === "leg"
          ? "fitness.plan.exercise.warmupLeg"
          : category === "push" || category === "pull"
            ? "fitness.plan.exercise.warmupPull"
            : "fitness.plan.exercise.warmupGeneral",
      ),
      prescription: messageText("fitness.plan.duration.range", { minimum: 5, maximum: 7 }),
      loadGuidance: messageText("fitness.plan.load.startLight"),
      effort: sourceText("RPE 2-3"),
      detail: [messageText("fitness.plan.detail.noBaselineLoad")],
    },
    {
      phase: "primary",
      exercise: messageText("fitness.plan.exercise.awaitBaseline"),
      prescription: sourceText("-"),
      loadGuidance: messageText("fitness.plan.load.noAutomaticEstimate"),
      effort: sourceText("-"),
      detail: [messageText("fitness.plan.detail.baselineRequired")],
      caution: true,
    },
  ];
}

function nonSetDurationRange(session: SessionRow) {
  const minutes = Math.max(1, Math.round(session.durationSeconds / 60));
  const margin = minutes >= 20 ? 5 : Math.max(2, Math.round(minutes * 0.2));
  return {
    minimum: Math.max(1, minutes - margin),
    maximum: minutes + margin,
  };
}

function buildNonSetCourseItems(
  phaseLabel: string,
  session: SessionRow,
): CourseItem[] {
  const minutes = Math.max(1, Math.round(session.durationSeconds / 60));
  const effort =
    session.effortRaw?.trim() && session.effortRaw.trim() !== "31"
      ? sourceText(displayEffort(session.effortRaw))
      : messageText("fitness.plan.effort.byFeel");
  return [
    {
      phase: "primary",
      exercise: sourceText(phaseLabel),
      prescription: messageText("fitness.plan.duration.about", { minutes }),
      loadGuidance: messageText("fitness.plan.load.keepTrackingMethod"),
      effort,
      detail: [messageText("fitness.plan.detail.writeBack")],
    },
  ];
}

function buildBriefing(
  latestSession: DashboardSession | null,
  latestCardio: DashboardSession | null,
  latestRecovery: DashboardRecovery | null,
  category: PlanCategory,
  phaseLabel: string,
  planningDate: string,
) {
  const lines: UiText[] = [];

  if (latestSession) {
    const cardioSameDay =
      latestCardio &&
      latestCardio.sessionId !== latestSession.sessionId &&
      latestCardio.localDate === latestSession.localDate;
    lines.push(
      cardioSameDay
        ? messageText(
            latestCardio.effort
              ? "fitness.briefing.latestSessionCardioEffort"
              : "fitness.briefing.latestSessionCardio",
            {
              title: latestSession.title,
              minutes: Math.round(latestSession.durationMinutes),
              cardioMinutes: Math.round(latestCardio.durationMinutes),
              ...(latestCardio.effort
                ? { effort: displayEffort(latestCardio.effort) }
                : {}),
            },
          )
        : messageText("fitness.briefing.latestSession", {
            title: latestSession.title,
            minutes: Math.round(latestSession.durationMinutes),
          }),
    );
  }

  if (latestRecovery) {
    const recoveryAge = daysAgo(latestRecovery.noteDate, planningDate);
    if (recoveryAge > 2) {
      lines.push(
        messageText("fitness.briefing.staleRecovery", {
          days: recoveryAge,
        }),
      );
    } else {
      lines.push(sourceText(latestRecovery.note));
    }
  } else {
    lines.push(
      messageText("fitness.briefing.noRecovery", { phase: phaseLabel }),
    );
  }

  if (category === "recovery") {
    lines.push(messageText("fitness.briefing.recoveryDay"));
  }

  return lines.slice(0, 3);
}

function strengthTrend(
  rows: Array<{
    startedAt: string;
    weightKg: number | null;
    reps: number | null;
  }>,
) {
  const bySession = new Map<string, number>();
  for (const row of rows) {
    if (
      row.weightKg === null ||
      row.weightKg <= 0 ||
      row.reps === null ||
      row.reps < 1 ||
      row.reps > 10
    ) {
      continue;
    }
    const value = row.weightKg * (1 + row.reps / 30);
    const current = bySession.get(row.startedAt) ?? 0;
    bySession.set(row.startedAt, Math.max(current, value));
  }
  return [...bySession.entries()]
    .map(([date, value]) => ({
      date: date.slice(0, 10),
      value: Math.round(value * 10) / 10,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

type StrengthSetTrendRow = {
  setId: string;
  sessionId: string;
  startedAt: string;
  sessionVenue: string | null;
  setVenue: string | null;
  exercise: string;
  rawExercise?: string;
  weightKg: number | null;
  reps: number | null;
};

function selectStrengthExercise(
  rows: StrengthSetTrendRow[],
  configuredExercise: string | null | undefined,
  notes: NoteRow[],
) {
  const configured = configuredExercise
    ? canonicalExerciseIdentity(configuredExercise)
    : null;
  if (configured) {
    const match = rows.findLast(
      (row) =>
        canonicalExerciseIdentity(row.exercise) === configured ||
        (row.rawExercise
          ? canonicalExerciseIdentity(row.rawExercise) === configured
          : false),
    );
    if (match) return match.exercise;
  }

  const rowsByExercise = new Map<string, StrengthSetTrendRow[]>();
  for (const row of rows) {
    const key = canonicalExerciseIdentity(row.exercise);
    if (!key) continue;
    const exerciseRows = rowsByExercise.get(key) ?? [];
    exerciseRows.push(row);
    rowsByExercise.set(key, exerciseRows);
  }

  return [...rowsByExercise.values()]
    .map((exerciseRows) => {
      const comparable = venueComparableStrengthRows(exerciseRows, notes).filter(
        (row) =>
          row.weightKg !== null &&
          row.weightKg > 0 &&
          row.reps !== null &&
          row.reps >= 1 &&
          row.reps <= 10,
      );
      return {
        label: exerciseRows[0].exercise.trim(),
        sessions: new Set(comparable.map((row) => row.sessionId)).size,
        latest: comparable.reduce(
          (latest, row) => (row.startedAt > latest ? row.startedAt : latest),
          "",
        ),
      };
    })
    .filter((candidate) => candidate.sessions >= 2)
    .sort(
      (left, right) =>
        right.latest.localeCompare(left.latest) ||
        right.sessions - left.sessions ||
        left.label.localeCompare(right.label),
    )[0]?.label ?? null;
}

function venueComparableStrengthRows(
  rows: StrengthSetTrendRow[],
  notes: NoteRow[],
) {
  if (rows.length === 0) return rows;
  const rowsBySession = new Map<string, StrengthSetTrendRow[]>();
  for (const row of rows) {
    const sessionRows = rowsBySession.get(row.sessionId) ?? [];
    sessionRows.push(row);
    rowsBySession.set(row.sessionId, sessionRows);
  }

  const venueBySession = new Map<string, VenueResolution>();
  for (const [sessionId, sessionRows] of rowsBySession) {
    venueBySession.set(
      sessionId,
      resolveVenueLabels([
        sessionRows[0]?.sessionVenue,
        ...sessionRows.map((row) => row.setVenue),
        ...notes
          .filter((note) => note.sessionId === sessionId)
          .map((note) => note.venue),
      ]),
    );
  }

  const referenceSessionId = [...rowsBySession.entries()].sort((left, right) =>
    right[1][0].startedAt.localeCompare(left[1][0].startedAt),
  )[0]?.[0];
  if (!referenceSessionId) return [];
  const referenceVenue = venueBySession.get(referenceSessionId)!;

  return rows.filter((row) => {
    if (row.sessionId === referenceSessionId) return true;
    const candidateVenue = venueBySession.get(row.sessionId)!;
    if (referenceVenue.kind === "conflict") return false;
    if (referenceVenue.kind === "unknown") {
      return candidateVenue.kind === "unknown";
    }
    return (
      candidateVenue.kind === "known" &&
      !venuesConflict(referenceVenue, candidateVenue)
    );
  });
}

function cardioTrend(rows: CardioDayRow[]) {
  return rows
    .filter(
      (row) =>
        row.state === "recorded_workout" &&
        row.minutes !== null &&
        row.minutes > 0,
    )
    .map((row) => ({
      date: row.date,
      value: Math.round(row.minutes! * 10) / 10,
    }));
}

function sumWindow(points: TrendPoint[], cutoff: string, start: number, end: number) {
  return points
    .filter((point) => {
      const age = daysAgo(point.date, cutoff);
      return age >= start && age < end;
    })
    .reduce((total, point) => total + point.value, 0);
}

function buildProgress(
  body: DailyBody[],
  strength: TrendPoint[],
  cardio: TrendPoint[],
  cutoff: string,
  goalType: FitnessGoalType = "general",
  strengthExercise: string | null = null,
): ProgressData {
  const recentBody28 = rowsInWindow(body, cutoff, 28);
  const body28Coverage = recentBody28.length;
  const body28Span = windowSpanDays(recentBody28);
  const body28Adequate = body28Coverage >= 8 && body28Span >= 14;
  const muscleBody28 = recentBody28.filter(
    (row): row is DailyBody & { muscleMassKg: number } =>
      row.muscleMassKg !== null,
  );
  const muscle28Span = windowSpanDays(muscleBody28);
  const muscle28Adequate =
    muscleBody28.length >= 8 && muscle28Span >= 14;
  const weight28Trend = body28Adequate
    ? projectedTrend(recentBody28, "weightKg")
    : null;
  const muscle28Trend = muscle28Adequate
    ? projectedTrend(muscleBody28, "muscleMassKg")
    : null;
  const recentWeight7Rows = rowsInWindow(body, cutoff, 7);
  const previousWeight7Rows = body.filter((row) => {
    const age = daysAgo(row.date, cutoff);
    return age >= 7 && age < 14;
  });
  const recentWeight7 = mean(windowValues(body, cutoff, 0, 7, "weightKg"));
  const previousWeight7 = mean(windowValues(body, cutoff, 7, 14, "weightKg"));
  const recentMuscle28 = mean(
    windowValues(body, cutoff, 0, 28, "muscleMassKg"),
  );
  const sevenDayComparisonAdequate =
    recentWeight7Rows.length >= 4 && previousWeight7Rows.length >= 4;

  const weight7Change =
    sevenDayComparisonAdequate &&
    recentWeight7 !== null &&
    previousWeight7 !== null
      ? recentWeight7 - previousWeight7
      : null;
  const latestStrength = strength.at(-1)?.value ?? null;
  const previousStrength = strength.at(-2)?.value ?? null;
  const strengthChange =
    latestStrength !== null && previousStrength !== null
      ? latestStrength - previousStrength
      : null;
  const cardio28 = sumWindow(cardio, cutoff, 0, 28);
  const previousCardio28 = sumWindow(cardio, cutoff, 28, 56);

  let verdict: UiText = messageText("fitness.progress.verdict.accumulating");
  if (goalType === "fat_loss" && weight28Trend !== null) {
    if (weight28Trend < -0.2) {
      verdict =
        muscle28Trend === null
          ? messageText("fitness.progress.verdict.fatLossWeightDown")
          : muscle28Trend > -0.3
            ? messageText("fitness.progress.verdict.fatLossEffective")
            : messageText("fitness.progress.verdict.fatLossWatchMuscle");
    } else if (Math.abs(weight28Trend) <= 0.2) {
      verdict = messageText("fitness.progress.verdict.fatLossFlat");
    } else {
      verdict = messageText("fitness.progress.verdict.fatLossRebound");
    }
  } else if (goalType === "muscle_gain") {
    if (muscle28Trend !== null && muscle28Trend > 0.15) {
      verdict = messageText("fitness.progress.verdict.muscleGainUp");
    } else if (strengthChange !== null && strengthChange > 0) {
      verdict = messageText("fitness.progress.verdict.muscleGainStrengthUp");
    }
  } else if (goalType === "strength" && strengthChange !== null) {
    verdict =
      strengthChange >= 0
        ? messageText("fitness.progress.verdict.strengthUp")
        : messageText("fitness.progress.verdict.strengthDown");
  } else if (goalType === "endurance" && cardio28 > 0) {
    verdict =
      previousCardio28 > 0
        ? cardio28 >= previousCardio28
          ? messageText("fitness.progress.verdict.enduranceUp")
          : messageText("fitness.progress.verdict.enduranceDown")
        : messageText("fitness.progress.verdict.enduranceBaseline");
  } else if (goalType === "maintenance" && weight28Trend !== null) {
    verdict =
      Math.abs(weight28Trend) <= 0.2
        ? messageText("fitness.progress.verdict.maintenanceStable")
        : messageText("fitness.progress.verdict.maintenanceChanged");
  } else if (weight28Trend !== null) {
    verdict = messageText(
      weight28Trend < 0
        ? "fitness.progress.verdict.weightDown"
        : "fitness.progress.verdict.weightUp",
      { value: Math.abs(weight28Trend).toFixed(2) },
    );
  } else if (strengthChange !== null) {
    verdict = messageText(
      strengthChange < 0
        ? "fitness.progress.verdict.strengthValueDown"
        : "fitness.progress.verdict.strengthValueUp",
      { value: Math.abs(strengthChange).toFixed(1) },
    );
  }

  const metrics: ProgressMetric[] = [
    {
      label: messageText("fitness.progress.metric.weight7"),
      value:
        recentWeight7 !== null && recentWeight7Rows.length >= 2
          ? sourceText(`${recentWeight7.toFixed(2)} kg`)
          : messageText("fitness.progress.value.insufficient"),
      change:
        weight7Change !== null
          ? messageText("fitness.progress.change.weightCoverage", {
              change: signed(weight7Change),
              recentDays: recentWeight7Rows.length,
              previousDays: previousWeight7Rows.length,
            })
          : messageText("fitness.progress.change.coverage", {
              days: recentWeight7Rows.length,
              total: 7,
            }),
      tone:
        weight7Change === null
          ? "neutral"
          : goalType === "fat_loss"
            ? weight7Change <= 0
              ? "positive"
              : "watch"
            : goalType === "maintenance"
              ? Math.abs(weight7Change) <= 0.5
                ? "positive"
                : "watch"
              : "neutral",
    },
    {
      label: messageText("fitness.progress.metric.muscle28"),
      value:
        recentMuscle28 !== null
          ? sourceText(`${recentMuscle28.toFixed(2)} kg`)
          : messageText("fitness.progress.value.insufficient"),
      change:
        muscle28Trend !== null
          ? messageText("fitness.progress.change.muscleTrend", {
              change: signed(muscle28Trend),
            })
          : messageText("fitness.progress.change.coverageSpan", {
              days: muscleBody28.length,
              span: muscle28Span,
            }),
      tone:
        muscle28Trend === null || muscle28Trend > -0.3
          ? "neutral"
          : "watch",
    },
    {
      label: strengthExercise
        ? messageText("fitness.progress.metric.strengthNamed", {
            exercise: exerciseText(strengthExercise),
          })
        : messageText("fitness.progress.metric.strength"),
      value:
        latestStrength !== null
          ? sourceText(`${latestStrength.toFixed(1)} kg`)
          : messageText("fitness.progress.value.insufficient"),
      change:
        strengthChange !== null
          ? messageText("fitness.progress.change.strength", {
              change: signed(strengthChange, 1),
            })
          : strengthExercise
            ? messageText("fitness.progress.change.sameExercise")
            : messageText("fitness.progress.change.needsTwoSessions"),
      tone:
        strengthChange === null
          ? "neutral"
          : strengthChange >= 0
            ? "positive"
            : "watch",
    },
  ];

  const insights: UiText[] = [];
  if (weight28Trend !== null) {
    insights.push(
      messageText(
        weight28Trend < 0
          ? weight7Change !== null && weight7Change > 0
            ? "fitness.progress.insight.weightDownWithRebound"
            : "fitness.progress.insight.weightDown"
          : weight7Change !== null && weight7Change > 0
            ? "fitness.progress.insight.weightUpWithRebound"
            : "fitness.progress.insight.weightUp",
        {
          value: Math.abs(weight28Trend).toFixed(2),
          days: body28Coverage,
          span: body28Span,
          ...(weight7Change !== null && weight7Change > 0
            ? { rebound: weight7Change.toFixed(2) }
            : {}),
        },
      ),
    );
  } else {
    insights.push(
      messageText("fitness.progress.insight.weightInsufficient", {
        days: body28Coverage,
        span: body28Span,
      }),
    );
  }
  if (muscle28Trend !== null) {
    insights.push(
      messageText("fitness.progress.insight.muscleTrend", {
        change: signed(muscle28Trend),
      }),
    );
  } else {
    insights.push(
      messageText("fitness.progress.insight.weightCoverage", {
        days: recentWeight7Rows.length,
      }),
    );
  }
  insights.push(
    messageText(
      previousCardio28 > 0
        ? strengthExercise
          ? "fitness.progress.insight.cardioComparedNamed"
          : "fitness.progress.insight.cardioComparedNoStrength"
        : strengthExercise
          ? "fitness.progress.insight.cardioNamed"
          : "fitness.progress.insight.cardioNoStrength",
      {
        minutes: Math.round(cardio28),
        ...(previousCardio28 > 0
          ? { change: signed(cardio28 - previousCardio28, 0) }
          : {}),
        ...(strengthExercise
          ? { exercise: exerciseText(strengthExercise) }
          : {}),
      },
    ),
  );

  return {
    verdict,
    metrics,
    series: {
      body: {
        label: messageText("fitness.progress.series.body.label"),
        title: messageText("fitness.progress.series.body.title"),
        unit: "kg",
        points: body.map((row) => ({
          date: row.date,
          value: Math.round(row.weightKg * 100) / 100,
        })),
        note: messageText("fitness.progress.series.body.note"),
      },
      strength: {
        label: messageText("fitness.progress.series.strength.label"),
        title: strengthExercise
          ? messageText("fitness.progress.series.strength.titleNamed", {
              exercise: exerciseText(strengthExercise),
            })
          : messageText("fitness.progress.series.strength.title"),
        unit: "kg",
        points: strength,
        note: messageText("fitness.progress.series.strength.note"),
      },
      cardio: {
        label: messageText("fitness.progress.series.cardio.label"),
        title: messageText("fitness.progress.series.cardio.title"),
        unit: "minute",
        points: cardio,
        note: messageText("fitness.progress.series.cardio.note"),
      },
    },
    insights: insights.slice(0, 3),
  };
}

export async function getDashboardData(
  options: { planningVenue?: string | null } = {},
): Promise<DashboardData> {
  try {
    const db = getDb();
    const [
      latestMeasurementRows,
      bodyRows,
      rawStrengthSessionRows,
      rawCycleSessionRows,
      rawCardioRows,
      cardioDays,
      sessionNoteRows,
      cycleCompletionRows,
      profileRows,
      trainingScheduleRows,
      trainingBlockRows,
      trainingSelectionRows,
      nextCourseOverrideRows,
      plannedSessionRows,
      rawConstraintRows,
      rawStrengthSetRows,
    ] = await Promise.all([
      db
        .select()
        .from(bodyMeasurements)
        .orderBy(desc(bodyMeasurements.measuredAt))
        .limit(1),
      db
        .select({
          measuredAt: bodyMeasurements.measuredAt,
          localDate: bodyMeasurements.localDate,
          weightKg: bodyMeasurements.weightKg,
          bodyFatPct: bodyMeasurements.bodyFatPct,
          muscleMassKg: bodyMeasurements.muscleMassKg,
        })
        .from(bodyMeasurements)
        .orderBy(desc(bodyMeasurements.measuredAt))
        .limit(500),
      db
        .select()
        .from(workoutSessions)
        .where(
          and(
            eq(workoutSessions.sessionType, "Strength"),
            eq(workoutSessions.sessionIntent, "normal"),
            isNull(workoutSessions.voidedAt),
          ),
        )
        .orderBy(
          desc(workoutSessions.startedAtUtc),
          desc(workoutSessions.startedAt),
        ),
      db
        .select()
        .from(workoutSessions)
        .where(isNull(workoutSessions.voidedAt))
        .orderBy(
          desc(workoutSessions.startedAtUtc),
          desc(workoutSessions.startedAt),
        ),
      db
        .select()
        .from(workoutSessions)
        .where(
          and(
            like(workoutSessions.sessionType, "Cardio%"),
            isNull(workoutSessions.voidedAt),
          ),
        )
        .orderBy(
          asc(workoutSessions.startedAtUtc),
          asc(workoutSessions.startedAt),
        )
        .limit(500),
      db.all<CardioDayRow>(sql`
        WITH ranked AS (
          SELECT
            effective_date AS activity_date,
            corrected_value,
            reason,
            ROW_NUMBER() OVER (
              PARTITION BY target_scope, target_key, field_name
              ORDER BY recorded_at DESC, correction_id DESC
            ) AS rn
          FROM corrections
          WHERE target_scope = 'calendar_day'
            AND field_name = 'formal_cardio_performed'
        ),
        latest AS (
          SELECT activity_date, corrected_value, reason
          FROM ranked
          WHERE rn = 1
        )
        SELECT
          d.activity_date AS "date",
          CASE
            WHEN LOWER(TRIM(COALESCE(l.corrected_value, '')))
              IN ('0', 'false', 'no', 'none')
              THEN 'explicit_none'
            WHEN d.formal_cardio_sessions > 0
              THEN 'recorded_workout'
            WHEN LOWER(TRIM(COALESCE(l.corrected_value, '')))
              IN ('1', 'true', 'yes')
              THEN 'recorded_workout'
            ELSE 'no_record'
          END AS "state",
          CASE
            WHEN LOWER(TRIM(COALESCE(l.corrected_value, '')))
              IN ('0', 'false', 'no', 'none')
              THEN 0
            WHEN d.formal_cardio_sessions > 0
              THEN CAST(d.formal_cardio_sessions AS INTEGER)
            ELSE NULL
          END AS "sessions",
          CASE
            WHEN LOWER(TRIM(COALESCE(l.corrected_value, '')))
              IN ('0', 'false', 'no', 'none')
              THEN 0.0
            WHEN d.formal_cardio_sessions > 0
              THEN CAST(d.formal_cardio_minutes AS REAL)
            ELSE NULL
          END AS "minutes",
          l.reason AS "correctionReason"
        FROM v_daily_training d
        LEFT JOIN latest l USING (activity_date)
        WHERE d.formal_cardio_sessions > 0
          OR l.corrected_value IS NOT NULL
        ORDER BY d.activity_date ASC
      `),
      db
        .select()
        .from(sessionNotes)
        .where(sql`(${sessionNotes.sessionId} IS NULL OR NOT EXISTS (
          SELECT 1 FROM workout_sessions hidden_session
          WHERE hidden_session.session_id = ${sessionNotes.sessionId}
            AND hidden_session.voided_at IS NOT NULL
        ))`)
        .orderBy(desc(sessionNotes.noteDate), desc(sessionNotes.noteId))
        .limit(500),
      db
        .select()
        .from(sessionNotes)
        .where(
          and(
            or(
              eq(sessionNotes.noteType, "Cycle phase completed"),
              eq(sessionNotes.noteType, "Explicit non-event"),
            ),
            sql`(${sessionNotes.sessionId} IS NULL OR NOT EXISTS (
              SELECT 1 FROM workout_sessions hidden_session
              WHERE hidden_session.session_id = ${sessionNotes.sessionId}
                AND hidden_session.voided_at IS NOT NULL
            ))`,
          ),
        )
        .orderBy(desc(sessionNotes.noteDate), desc(sessionNotes.noteId))
        .limit(120),
      db.select().from(profile).limit(1),
      db
        .select()
        .from(trainingScheduleEvents)
        .where(isNull(trainingScheduleEvents.voidedAt))
        .orderBy(
          asc(trainingScheduleEvents.effectiveDate),
          asc(trainingScheduleEvents.recordedAt),
          asc(trainingScheduleEvents.eventId),
        ),
      db
        .select()
        .from(trainingBlocks)
        .where(isNull(trainingBlocks.endsOn))
        .orderBy(desc(trainingBlocks.startsOn), desc(trainingBlocks.createdAt)),
      db
        .select()
        .from(trainingExerciseSelections)
        .orderBy(
          desc(trainingExerciseSelections.recordedAt),
          desc(trainingExerciseSelections.selectionId),
        ),
      db
        .select()
        .from(trainingNextCourseOverrides)
        .where(
          and(
            isNull(trainingNextCourseOverrides.consumedAt),
            isNull(trainingNextCourseOverrides.voidedAt),
          ),
        )
        .orderBy(
          desc(trainingNextCourseOverrides.recordedAt),
          desc(trainingNextCourseOverrides.overrideId),
        ),
      db
        .select()
        .from(trainingPlannedSessions)
        .orderBy(
          desc(trainingPlannedSessions.recordedAt),
          desc(trainingPlannedSessions.planId),
        ),
      db
        .select()
        .from(operatingConstraints)
        .orderBy(desc(operatingConstraints.effectiveDate)),
      db
        .select({
          setId: workoutSets.setId,
          sessionId: workoutSessions.sessionId,
          startedAt: workoutSessions.startedAt,
          sessionVenue: workoutSessions.venueManual,
          setVenue: workoutSets.venueManual,
          exercise: workoutSets.exercise,
          weightKgReported: workoutSets.weightKgReported,
          reps: workoutSets.reps,
          effortRaw: workoutSets.effortRaw,
          reportedLoadXRepsKg: workoutSets.reportedLoadXRepsKg,
        })
        .from(workoutSets)
        .innerJoin(
          workoutSessions,
          eq(workoutSets.sessionId, workoutSessions.sessionId),
        )
        .where(
          and(
            eq(workoutSessions.sessionType, "Strength"),
            eq(workoutSessions.sessionIntent, "normal"),
            isNull(workoutSessions.voidedAt),
          ),
        )
        .orderBy(
          asc(workoutSessions.startedAtUtc),
          asc(workoutSessions.startedAt),
        ),
    ]);

    const projectedWorkout = await effectiveWorkoutRecords(
      { sessions: rawCycleSessionRows, sets: rawStrengthSetRows },
      db,
    );
    const sessionsById = new Map(
      projectedWorkout.sessions.map((session) => [session.sessionId, session]),
    );
    const strengthSessionRows = rawStrengthSessionRows.map(
      (session) => sessionsById.get(session.sessionId) ?? session,
    );
    const cycleSessionRows = projectedWorkout.sessions;
    const cardioRows = rawCardioRows.map(
      (session) => sessionsById.get(session.sessionId) ?? session,
    );
    const rawExerciseBySetId = new Map(
      rawStrengthSetRows.map((set) => [set.setId, set.exercise]),
    );
    const strengthSetRows = projectedWorkout.sets.map((set) => ({
      ...set,
      weightKg: set.weightKgReported,
      rawExercise: rawExerciseBySetId.get(set.setId),
    }));

    const latest = latestMeasurementRows[0];
    const latestStrengthRow = strengthSessionRows[0];
    const recordedCardioDates = new Set(
      cardioDays
        .filter((row) => row.state === "recorded_workout")
        .map((row) => row.date),
    );
    const latestCardioRow = cardioRows
      .filter(
        (row) =>
          row.totalSetsReported === 0 &&
          recordedCardioDates.has(sessionLocalDate(row)),
      )
      .at(-1);
    const recoveryRows = sessionNoteRows.filter(
      (note) => note.noteType === "Recovery status",
    );
    const venueNotes = sessionNoteRows;
    const latestRecoveryObservation = recoveryRows[0];
    const currentProfile = profileRows[0];
    const currentTrainingBlock = currentProfile
      ? trainingBlockRows.find(
          (block) => block.profileId === currentProfile.profileId,
        ) ?? null
      : null;
    const timezone = normaliseTimeZone(currentProfile?.timezone);
    const planningDate = dateInTimeZone(new Date(), timezone);
    const { constraints } = await effectiveOperatingConstraints(
      rawConstraintRows,
      planningDate,
      db,
    );
    const currentVenue = options.planningVenue?.trim() || null;
    const dashboardProfile = currentProfile
      ? {
          displayName: currentProfile.displayName,
          primaryGoal: currentProfile.primaryGoal,
          goalType:
            currentProfile.goalType ??
            classifyGoalType(currentProfile.primaryGoal),
          timezone,
          preferredLocale: isAppLocale(currentProfile.preferredLocale)
            ? currentProfile.preferredLocale
            : DEFAULT_APP_LOCALE,
          setupCompleted: currentProfile.setupCompleted,
          currentTrainingBlock: currentTrainingBlock
            ? {
                blockId: currentTrainingBlock.blockId,
                goalType: currentTrainingBlock.goalType,
                primaryGoal: currentTrainingBlock.primaryGoal,
                startsOn: currentTrainingBlock.startsOn,
              }
            : null,
        }
      : null;
    const profileScheduleRows = currentProfile
      ? trainingScheduleRows.filter(
          (event) => event.profileId === currentProfile.profileId,
        )
      : [];
    const derivedSchedule = deriveTrainingSchedule(
      profileScheduleRows,
      planningDate,
    );
    const configuredCycle = parseCycle(
      currentProfile?.trainingCycle,
      currentProfile?.trainingCycleConfig,
    );
    const structuredCycle = parseStoredTrainingCycleConfig(
      currentProfile?.trainingCycleConfig,
    );
    const latestCycleCompletionRow = cycleSessionRows.find((session) =>
      matchedCompletedTrainingPhase({
        phases: configuredCycle,
        sessionTitle: session.sessionTitle,
        sessionType: session.sessionType,
        trainingPhaseId: session.trainingPhaseId,
      }),
    );
    const inferredNextPhase = inferNextCyclePhase({
      trainingCycle: currentProfile?.trainingCycle,
      trainingCycleConfig: currentProfile?.trainingCycleConfig,
      latestCompletedTitle: latestCycleCompletionRow?.sessionTitle,
      latestCompletedPhaseId: latestCycleCompletionRow?.trainingPhaseId,
      latestCompletedSessionType: latestCycleCompletionRow?.sessionType,
      latestCompletedDate: latestCycleCompletionRow
        ? sessionLocalDate(latestCycleCompletionRow)
        : undefined,
      completionNotes: cycleCompletionRows,
      planningDate,
      pausedIntervals: derivedSchedule.intervals,
    });
    const plannedSession: PlannedSessionRow | null =
      currentProfile && currentTrainingBlock && inferredNextPhase
        ? plannedSessionRows.find(
            (candidate) =>
              candidate.profileId === currentProfile.profileId &&
              candidate.trainingBlockId === currentTrainingBlock.blockId &&
              candidate.phaseId === inferredNextPhase.id &&
              candidate.localDate === planningDate &&
              candidate.consumedAt === null &&
              candidate.voidedAt === null,
          ) ?? null
        : null;
    const plannedBatchIds = new Set(
      plannedSessionRows.map((candidate) => candidate.overrideBatchId),
    );
    const profileTrainingSelections = currentProfile
      ? trainingSelectionRows.filter(
          (selection) =>
            selection.profileId === currentProfile.profileId &&
            (!selection.overrideBatchId ||
              !plannedBatchIds.has(selection.overrideBatchId) ||
              selection.overrideBatchId === plannedSession?.overrideBatchId),
        )
      : [];
    const trainingSchedule: DashboardTrainingSchedule = {
      status: derivedSchedule.status,
      planningDate,
      cycle: configuredCycle,
      nextPhase: inferredNextPhase,
      pause: derivedSchedule.pause
        ? {
            startsOn: derivedSchedule.pause.startsOn,
            resumeOn: derivedSchedule.pause.resumeOn,
            reason: derivedSchedule.pause.reason,
          }
        : null,
    };
    const dataCutoff =
      [
        latest?.localDate,
        latestStrengthRow ? sessionLocalDate(latestStrengthRow) : undefined,
        latestCycleCompletionRow
          ? sessionLocalDate(latestCycleCompletionRow)
          : undefined,
        cardioDays.at(-1)?.date,
        sessionNoteRows[0]?.noteDate,
        cycleCompletionRows[0]?.noteDate,
      ]
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null;

    if (
      !latest &&
      !latestStrengthRow &&
      !latestCycleCompletionRow &&
      !latestCardioRow &&
      !latestRecoveryObservation &&
      cardioDays.length === 0 &&
      cycleCompletionRows.length === 0
    ) {
      return {
        status: "empty",
        profile: dashboardProfile,
        latestMeasurement: null,
        latestStrength: null,
        latestReview: null,
        latestCardio: null,
        latestRecovery: null,
        trainingSchedule,
        todayPlan: null,
        progress: null,
        dataCutoff: null,
        message: null,
      };
    }

    const cutoff = dataCutoff ?? planningDate;
    const latestCardio = toDashboardSession(latestCardioRow);
    const category = inferredNextPhase?.category ?? "training";
    const recovery = recoveryRows.find((note) =>
      recoveryRelevantToPhase({
        recovery: note,
        phase: inferredNextPhase,
        structured: Boolean(structuredCycle),
        sessions: cycleSessionRows,
      }),
    );
    const latestRecovery: DashboardRecovery | null = recovery
      ? {
          noteDate: recovery.noteDate,
          area: recovery.exerciseOrArea,
          note: recovery.note,
          pain010: recovery.pain010,
        }
      : null;
    const adjustment = trainingAdjustmentFor({
      phaseKind: inferredNextPhase?.kind ?? "training",
      pain010: recovery?.pain010,
      recoveryAgeDays: recovery
        ? daysAgo(recovery.noteDate, planningDate)
        : null,
    });
    const matchedPhaseSession = inferredNextPhase
      ? cycleSessionRows.find(
          (session) =>
            session.sessionIntent === "normal" &&
            (!currentTrainingBlock ||
              session.trainingBlockId === currentTrainingBlock.blockId) &&
            sessionMatchesCyclePhase({
              phase: inferredNextPhase,
              sessionTitle: session.sessionTitle,
              sessionType: session.sessionType,
              trainingPhaseId: session.trainingPhaseId,
            }),
        )
      : undefined;
    const hasConfiguredRoutine = Boolean(inferredNextPhase?.routine?.length);
    const comparableSession =
      matchedPhaseSession &&
      (hasConfiguredRoutine ||
        (matchedPhaseSession.sessionType === "Strength" &&
          matchedPhaseSession.totalSetsReported > 0))
        ? matchedPhaseSession
        : undefined;
    const durationBaselineSession =
      matchedPhaseSession &&
      !hasConfiguredRoutine &&
      !comparableSession
        ? matchedPhaseSession
        : undefined;
    const planningReferenceSession =
      comparableSession ?? durationBaselineSession;
    const latestStrengthPhase = latestStrengthRow
      ? configuredCycle.find((phase) =>
          sessionMatchesCyclePhase({
            phase,
            sessionTitle: latestStrengthRow.sessionTitle,
            trainingPhaseId: latestStrengthRow.trainingPhaseId,
          }),
        )
      : undefined;
    const latestReviewSessions = latestStrengthRow
      ? reviewSessionGroup(strengthSessionRows, latestStrengthRow)
      : [];
    const latestReviewSession = latestStrengthRow
      ? latestReviewSessions.length > 1
        ? aggregateReviewSession(
            latestReviewSessions,
            latestStrengthPhase?.raw ?? latestStrengthRow.sessionTitle,
          )
        : latestStrengthRow
      : undefined;
    const latestStrength = toDashboardSession(latestReviewSession);
    const latestCompletedSession = toDashboardSession(
      latestCycleCompletionRow &&
        latestReviewSessions.some(
          (session) => session.sessionId === latestCycleCompletionRow.sessionId,
        )
        ? latestReviewSession
        : latestCycleCompletionRow,
    );
    const previousReviewAnchor = latestStrengthRow
      ? strengthSessionRows
          .slice(1)
          .find(
            (session) =>
              sessionLocalDate(session) !==
                sessionLocalDate(latestStrengthRow) &&
              session.sessionIntent === latestStrengthRow.sessionIntent &&
              (!latestStrengthRow.trainingBlockId ||
                session.trainingBlockId === latestStrengthRow.trainingBlockId) &&
              (latestStrengthPhase
                ? sessionMatchesCyclePhase({
                    phase: latestStrengthPhase,
                    sessionTitle: session.sessionTitle,
                    trainingPhaseId: session.trainingPhaseId,
                  })
                : !structuredCycle &&
                  planCategory(latestStrengthRow.sessionTitle) !== "unknown" &&
                  planCategory(session.sessionTitle) ===
                    planCategory(latestStrengthRow.sessionTitle)),
          )
      : undefined;
    const previousReviewSessions = previousReviewAnchor
      ? reviewSessionGroup(strengthSessionRows, previousReviewAnchor)
      : [];
    const previousReviewSession = previousReviewAnchor
      ? previousReviewSessions.length > 1
        ? aggregateReviewSession(
            previousReviewSessions,
            latestStrengthPhase?.raw ?? previousReviewAnchor.sessionTitle,
          )
        : previousReviewAnchor
      : undefined;
    const reviewSetsForSessions = async (sessions: SessionRow[]) => {
      const ordered = [...sessions].sort((left, right) =>
        (left.startedAtUtc ?? left.startedAt).localeCompare(
          right.startedAtUtc ?? right.startedAt,
        ),
      );
      return (
        await Promise.all(
          ordered.map((session) =>
            db
              .select()
              .from(workoutSets)
              .where(eq(workoutSets.sessionId, session.sessionId))
              .orderBy(asc(workoutSets.setNoSession)),
          ),
        )
      ).flat();
    };
    const [rawComparableSets, rawLatestReviewSets, rawPreviousReviewSets] =
      await Promise.all([
        comparableSession
          ? db
              .select()
              .from(workoutSets)
              .where(eq(workoutSets.sessionId, comparableSession.sessionId))
              .orderBy(asc(workoutSets.setNoSession))
          : Promise.resolve([] as SetRow[]),
        latestReviewSessions.length > 0
          ? reviewSetsForSessions(latestReviewSessions)
          : Promise.resolve([] as SetRow[]),
        previousReviewSessions.length > 0
          ? reviewSetsForSessions(previousReviewSessions)
          : Promise.resolve([] as SetRow[]),
      ]);
    const projectedReviewSets = await effectiveWorkoutRecords(
      {
        sets: [
          ...rawComparableSets,
          ...rawLatestReviewSets,
          ...rawPreviousReviewSets,
        ],
      },
      db,
    );
    const effectiveSetById = new Map(
      projectedReviewSets.sets.map((set) => [set.setId, set]),
    );
    const inheritedReviewVenueBySessionId = new Map(
      [...latestReviewSessions, ...previousReviewSessions].map((session) => {
        const resolution = resolveSessionVenue(
          session,
          venueNotes,
          [...rawLatestReviewSets, ...rawPreviousReviewSets].filter(
            (set) => set.sessionId === session.sessionId,
          ),
        );
        return [
          session.sessionId,
          resolution.kind === "known" ? resolution.label : null,
        ];
      }),
    );
    const withRawExercise = (set: SetRow): SetRow => {
      const projected = effectiveSetById.get(set.setId) ?? set;
      return {
        ...projected,
        rawExercise: set.exercise,
        venueManual:
          projected.venueManual ??
          inheritedReviewVenueBySessionId.get(set.sessionId) ??
          null,
      };
    };
    const comparableSets = rawComparableSets.map(withRawExercise);
    const latestReviewSets = rawLatestReviewSets.map(withRawExercise);
    const previousReviewSets = rawPreviousReviewSets.map(withRawExercise);

    const highPainRecovery = adjustment === "recover";
    const reduced = adjustment === "reduce";
    const exactCourseLoadAllowed = comparableSession
      ? sessionVenueMetadataIsConsistent(
          comparableSets,
          comparableSession,
          venueNotes,
          currentVenue,
        )
      : false;
    const recoveryAge = latestRecovery
      ? daysAgo(latestRecovery.noteDate, planningDate)
      : null;
    const hasRecentRecovery =
      recoveryAge !== null &&
      recoveryAge >= 0 &&
      recoveryAge <= 2;
    let decisionCode: TodayPlan["decisionCode"] = "ready";
    if (highPainRecovery) decisionCode = "recover_first";
    else if (reduced) decisionCode = "reduce";
    else if (category === "recovery") decisionCode = "recovery_day";
    else if (!planningReferenceSession) decisionCode = "baseline_required";
    const phaseLabel = inferredNextPhase?.raw ?? "Training";

    const todayPlan: TodayPlan | null =
      trainingSchedule.status === "paused"
        ? null
        : withTrainingCourseFingerprint({
            decisionCode,
            adjustment,
            phaseKind: inferredNextPhase?.kind ?? "training",
            sessionIntent: plannedSession?.sessionIntent ?? "normal",
            phaseLabel,
            durationMinutes:
              highPainRecovery
                ? { minimum: 10, maximum: 20 }
                : category === "recovery"
                  ? { minimum: 25, maximum: 35 }
                  : durationBaselineSession
                    ? nonSetDurationRange(durationBaselineSession)
                  : category === "training" && !planningReferenceSession
                    ? null
                    : { minimum: 50, maximum: 60 },
            confidence:
              (planningReferenceSession && hasRecentRecovery) ||
              category === "recovery"
                ? "medium"
                : "low",
            briefing: buildBriefing(
              latestCompletedSession ?? latestStrength,
              latestCardio,
              latestRecovery,
              category,
              phaseLabel,
              planningDate,
            ),
            items:
              highPainRecovery || category === "recovery"
                ? buildRecoveryCourseItems(highPainRecovery)
                : inferredNextPhase?.routine?.length
                  ? buildConfiguredCourseItems({
                      phase: inferredNextPhase,
                      sets: comparableSets,
                      selections: profileTrainingSelections,
                      nextOverrides: currentTrainingBlock
                        ? nextCourseOverrideRows.filter(
                            (override) =>
                              override.profileId === currentProfile?.profileId &&
                              override.trainingBlockId ===
                                currentTrainingBlock.blockId,
                          )
                        : [],
                      planningDate,
                      venue: currentVenue,
                      constraints,
                      reduced,
                      exactLoadAllowed: exactCourseLoadAllowed,
                    })
                : durationBaselineSession
                  ? buildNonSetCourseItems(
                      phaseLabel,
                      durationBaselineSession,
                    )
                : comparableSession && inferredNextPhase
                  ? buildHistoryCourseItems({
                      phase: inferredNextPhase,
                      sets: comparableSets,
                      selections: profileTrainingSelections,
                      planningDate,
                      venue: currentVenue,
                      constraints,
                      reduced,
                      exactLoadAllowed: exactCourseLoadAllowed,
                    })
                  : buildInsufficientCourseItems(category),
            referenceDate: planningReferenceSession
              ? sessionLocalDate(planningReferenceSession)
              : null,
            referenceContext: planningReferenceSession
              ? venueContext(
                  planningReferenceSession,
                  venueNotes,
                  comparableSession ? comparableSets : [],
                )
              : null,
            phaseId: inferredNextPhase?.id ?? null,
            planningDate,
            venue: currentVenue,
            profileUpdatedAt: currentProfile?.updatedAt ?? null,
          });

    const latestReview = latestReviewSession
      ? buildSessionReview(
          latestReviewSession,
          latestReviewSets,
          previousReviewSession,
          previousReviewSets,
          venueNotes,
          latestReviewSessions,
        )
      : null;

    const dailyBody = aggregateDailyBody(bodyRows);
    const comparableStrengthSets = strengthSetRows;
    const progressExercise = selectStrengthExercise(
      comparableStrengthSets,
      currentProfile?.strengthProgressExercise,
      venueNotes,
    );
    const progressExerciseIdentities = new Set(
      [progressExercise, currentProfile?.strengthProgressExercise]
        .map((exercise) =>
          exercise ? canonicalExerciseIdentity(exercise) : null,
        )
        .filter((exercise): exercise is string => Boolean(exercise)),
    );
    const progressStrengthSets = venueComparableStrengthRows(
      progressExercise
        ? comparableStrengthSets.filter(
            (row) =>
              progressExerciseIdentities.has(
                canonicalExerciseIdentity(row.exercise),
              ) ||
              Boolean(
                row.rawExercise &&
                  progressExerciseIdentities.has(
                    canonicalExerciseIdentity(row.rawExercise),
                  ),
              ),
          )
        : [],
      venueNotes,
    );
    const progress = buildProgress(
      dailyBody,
      strengthTrend(progressStrengthSets),
      cardioTrend(cardioDays),
      cutoff,
      currentProfile?.goalType ??
        classifyGoalType(currentProfile?.primaryGoal),
      progressExercise,
    );

    return {
      status: "ready",
      profile: dashboardProfile,
      latestMeasurement: latest
        ? {
            measuredAt: latest.measuredAt,
            localDate: latest.localDate!,
            weightKg: latest.weightKg,
            bodyFatPct: latest.bodyFatPct,
            muscleMassKg: latest.muscleMassKg,
            bodyWaterPct: latest.bodyWaterPct,
            visceralFatRating: latest.visceralFatRating,
          }
        : null,
      latestStrength,
      latestReview,
      latestCardio,
      latestRecovery,
      trainingSchedule,
      todayPlan,
      progress,
      dataCutoff,
      message: null,
    };
  } catch (error) {
    console.error("Fitness dashboard read failed", error);
    return {
      status: "unavailable",
      profile: null,
      latestMeasurement: null,
      latestStrength: null,
      latestReview: null,
      latestCardio: null,
      latestRecovery: null,
      trainingSchedule: {
        status: "active",
        planningDate: dateInTimeZone(new Date(), DEFAULT_TIMEZONE),
        cycle: [],
        nextPhase: null,
        pause: null,
      },
      todayPlan: null,
      progress: null,
      dataCutoff: null,
      message: null,
    };
  }
}
