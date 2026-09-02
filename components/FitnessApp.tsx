"use client";

import {
  CaretDown,
  ChartLineUp,
  CheckCircle,
  Clock,
  ForkKnife,
  GearSix,
  House,
  Info,
  MagnifyingGlass,
  NotePencil,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import {
  Activity,
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { NutritionView } from "@/components/NutritionView";
import { LogView } from "@/components/LogView";
import { TrainingScheduleControls } from "@/components/TrainingScheduleControls";
import { useI18n } from "@/components/i18n/I18nProvider";
import { ProfileSettingsDialog } from "@/components/profile/ProfileSettingsDialog";
import { clientUuid } from "@/lib/client-id";
import { exerciseText } from "@/lib/exercise-display";
import type {
  CourseItem,
  DashboardData,
  ProgressSeries,
  TrendPoint,
} from "@/lib/fitness";
import { renderUiText, type UiText } from "@/lib/i18n/ui-text";
import { addIsoDateDays } from "@/lib/training-schedule";
import { DEFAULT_TIMEZONE } from "@/lib/timezone.mjs";

type Tab = "today" | "nutrition" | "progress" | "log";
type ProgressKind = "body" | "strength" | "cardio";
type Range = 30 | 90 | "all";

const coursePhaseMessageKeys = {
  warmup: "fitness.course.phase.warmup",
  primary: "fitness.course.phase.primary",
  accessory: "fitness.course.phase.accessory",
  optional: "fitness.course.phase.optional",
} satisfies Record<CourseItem["phase"], string>;

const reviewSectionMessageKeys = {
  completed: "fitness.review.section.completed",
  assessment: "fitness.review.section.assessment",
  next: "fitness.review.section.next",
} as const;

const progressUnitMessageKeys = {
  kg: "fitness.progress.unit.kg",
  minute: "fitness.progress.unit.minute",
} satisfies Record<ProgressSeries["unit"], string>;

function standardPhaseMessageKey(label: string) {
  const normalized = label
    .trim()
    .toLocaleLowerCase("en")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");

  if (
    [
      "leg",
      "legs",
      "leg day",
      "lower body",
      "lower body day",
      "腿",
      "腿日",
      "腿部",
      "下肢",
      "下肢訓練",
      "下肢训练",
    ].includes(normalized)
  ) {
    return "fitness.phase.lowerBody";
  }
  if (
    ["push", "push day", "推", "推日", "推力", "推力訓練", "推力训练"].includes(
      normalized,
    )
  ) {
    return "fitness.phase.push";
  }
  if (
    ["pull", "pull day", "拉", "拉日", "拉力", "拉力訓練", "拉力训练"].includes(
      normalized,
    )
  ) {
    return "fitness.phase.pull";
  }
  return null;
}

function uiTextKey(value: UiText) {
  if (value.kind === "source") return `source:${value.text}`;
  const params = Object.entries(value.params ?? {}).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `message:${value.key}:${JSON.stringify(params)}`;
}

function courseItemKey(item: CourseItem) {
  if (item.phaseId && item.slotId) return `slot:${item.phaseId}:${item.slotId}`;
  if (item.exerciseKey) {
    return `exercise:${item.phase}:${item.exerciseKey}`;
  }
  return `display:${item.phase}:${uiTextKey(item.exercise)}`;
}

const navigation = [
  { id: "today" as const, labelKey: "fitness.nav.today", icon: House },
  {
    id: "nutrition" as const,
    labelKey: "fitness.nav.nutrition",
    icon: ForkKnife,
  },
  {
    id: "progress" as const,
    labelKey: "fitness.nav.progress",
    icon: ChartLineUp,
  },
  { id: "log" as const, labelKey: "fitness.nav.log", icon: NotePencil },
];

function isIsoDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(date.valueOf()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function greetingKeyForDevice(now: Date, timezone: string) {
  const hour = Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(now));
  if (hour < 12) return "fitness.greeting.morning";
  if (hour < 18) return "fitness.greeting.afternoon";
  return "fitness.greeting.evening";
}

function filterRange(
  points: TrendPoint[],
  range: Range,
  anchorDate: string | null,
) {
  if (range === "all" || points.length === 0) return points;
  const cutoff = Date.parse(
    `${anchorDate ?? points.at(-1)!.date}T00:00:00Z`,
  );
  const start = cutoff - (range - 1) * 86_400_000;
  return points.filter((point) => {
    const timestamp = Date.parse(`${point.date}T00:00:00Z`);
    return timestamp >= start && timestamp <= cutoff;
  });
}

function ProgressChart({
  series,
  range,
  anchorDate,
}: {
  series: ProgressSeries;
  range: Range;
  anchorDate: string | null;
}) {
  const { t, formatDate, formatNumber } = useI18n();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const chartRef = useRef<HTMLDivElement | null>(null);
  const points = useMemo(
    () => filterRange(series.points, range, anchorDate),
    [anchorDate, range, series.points],
  );
  const chart = useMemo(() => {
    if (points.length === 0) return null;
    const values = points.map((point) => point.value);
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const padding = Math.max((maximum - minimum) * 0.22, 0.25);
    const low = minimum - padding;
    const high = maximum + padding;
    const width = 360;
    const height = 150;
    const insetX = 12;
    const insetY = 18;
    const usableWidth = width - insetX * 2;
    const usableHeight = height - insetY * 2;
    const timestamps = points.map((point) =>
      Date.parse(`${point.date}T00:00:00Z`),
    );
    const recordedFirstTime = Math.min(...timestamps);
    const recordedLastTime = Math.max(...timestamps);
    const rangeAnchorTime = Date.parse(
      `${anchorDate ?? points.at(-1)!.date}T00:00:00Z`,
    );
    const firstTime =
      range === "all"
        ? recordedFirstTime
        : rangeAnchorTime - (range - 1) * 86_400_000;
    const lastTime = range === "all" ? recordedLastTime : rangeAnchorTime;
    const timeSpan = lastTime - firstTime;
    const coordinates = points.map((point, index) => ({
      ...point,
      x:
        timeSpan === 0
          ? width / 2
          : insetX +
            ((timestamps[index] - firstTime) / timeSpan) * usableWidth,
      y: insetY + ((high - point.value) / (high - low)) * usableHeight,
    }));

    return {
      width,
      height,
      minimum,
      maximum,
      coordinates,
      path: coordinates
        .map(
          (point, index) =>
            `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`,
        )
        .join(" "),
    };
  }, [anchorDate, points, range]);

  useEffect(() => {
    if (activeIndex === null) return;
    function closeOutside(event: PointerEvent) {
      if (!chartRef.current?.contains(event.target as Node)) {
        setActiveIndex(null);
      }
    }
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [activeIndex]);

  if (!chart) {
    return (
      <div className="chart-empty">
        <ChartLineUp size={24} aria-hidden="true" />
        <span>{t("fitness.chart.empty")}</span>
      </div>
    );
  }

  const latest = points.at(-1)!;
  const first = points[0];
  const delta = latest.value - first.value;
  const activePoint =
    activeIndex === null ? null : chart.coordinates[activeIndex] ?? null;
  const visibleChart = chart;
  const summaryDigits = series.unit === "kg" ? 1 : 0;
  const detailDigits = series.unit === "kg" ? 2 : 1;
  const seriesTitle = renderUiText(series.title, t, formatNumber);
  const unitLabel = t(progressUnitMessageKeys[series.unit]);
  const valueLabel = (value: number, digits: number) =>
    formatNumber(value, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });

  function nearestPointIndex(event: ReactPointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointerX =
      ((event.clientX - bounds.left) / Math.max(bounds.width, 1)) *
      visibleChart.width;
    return visibleChart.coordinates.reduce(
      (nearest, point, index) =>
        Math.abs(point.x - pointerX) <
        Math.abs(visibleChart.coordinates[nearest].x - pointerX)
          ? index
          : nearest,
      0,
    );
  }

  return (
    <div className="progress-chart" ref={chartRef}>
      <div className="chart-summary">
        <div>
          <span>{seriesTitle}</span>
          <strong>
            {valueLabel(latest.value, summaryDigits)}{" "}
            <small>{unitLabel}</small>
          </strong>
        </div>
        {points.length > 1 ? (
          <span className="delta-value">
            {t("fitness.chart.change", {
              period:
                range === "all"
                  ? t("fitness.chart.allPeriod")
                  : t("fitness.chart.days", { count: formatNumber(range) }),
              value: formatNumber(delta, {
                signDisplay: "exceptZero",
                minimumFractionDigits: summaryDigits,
                maximumFractionDigits: summaryDigits,
              }),
            })}
          </span>
        ) : null}
      </div>

      <div className="chart-plot">
        <svg
          viewBox={`0 0 ${chart.width} ${chart.height}`}
          role="group"
          aria-label={t("fitness.chart.pointsAria", { title: seriesTitle })}
          onPointerDown={(event) => {
            setActiveIndex(nearestPointIndex(event));
          }}
        >
          {points.length > 1 ? (
            <path d={chart.path} className="chart-line" aria-hidden="true" />
          ) : null}
          {chart.coordinates.map((point, index) => (
            <g
              key={`${point.date}-${index}`}
              role="button"
              tabIndex={0}
              aria-label={t("fitness.chart.pointAria", {
                date: formatDate(point.date, {
                  year: "numeric",
                  month: "numeric",
                  day: "numeric",
                }),
                value: valueLabel(point.value, detailDigits),
                unit: unitLabel,
              })}
              onPointerEnter={(event) => {
                if (event.pointerType === "mouse") setActiveIndex(index);
              }}
              onPointerLeave={(event) => {
                if (event.pointerType === "mouse") setActiveIndex(null);
              }}
              onFocus={() => setActiveIndex(index)}
              onBlur={() => setActiveIndex(null)}
              onClick={() => setActiveIndex(index)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setActiveIndex(index);
                }
                if (event.key === "Escape") setActiveIndex(null);
              }}
            >
              <circle
                cx={point.x}
                cy={point.y}
                r="18"
                className="chart-hit-area"
              />
              <circle
                cx={point.x}
                cy={point.y}
                r={index === chart.coordinates.length - 1 ? 4.5 : 2.8}
                className={
                  index === chart.coordinates.length - 1
                    ? "chart-point chart-point-latest"
                    : "chart-point"
                }
                aria-hidden="true"
              />
            </g>
          ))}
        </svg>
        {activePoint ? (
          <div
            className="chart-tooltip"
            role="status"
            aria-live="polite"
            style={{
              left: `${Math.min(78, Math.max(22, (activePoint.x / chart.width) * 100))}%`,
              top: `${Math.max(0, (activePoint.y / chart.height) * 100 - 4)}%`,
            }}
          >
            <span>
              {formatDate(activePoint.date, {
                year: "numeric",
                month: "numeric",
                day: "numeric",
                weekday: "short",
              })}
            </span>
            <strong>
              {valueLabel(activePoint.value, detailDigits)} {unitLabel}
            </strong>
          </div>
        ) : null}
      </div>

      <div className="chart-footer">
        <span>
          {formatDate(first.date, {
            year: "numeric",
            month: "numeric",
            day: "numeric",
          })}
        </span>
        <span>{renderUiText(series.note, t, formatNumber)}</span>
        <span>
          {formatDate(latest.date, {
            year: "numeric",
            month: "numeric",
            day: "numeric",
          })}
        </span>
      </div>
    </div>
  );
}

function CourseRow({
  item,
  onChooseAlternative,
}: {
  item: CourseItem;
  onChooseAlternative?: (item: CourseItem, trigger: HTMLButtonElement) => void;
}) {
  const { t, formatNumber } = useI18n();
  const notice = item.notice
    ?.map((line) => renderUiText(line, t, formatNumber))
    .join(" ");
  return (
    <details className={`course-row ${item.caution ? "course-row-watch" : ""}`}>
      <summary
        className={
          notice
            ? "course-row-summary course-row-summary-with-notice"
            : "course-row-summary"
        }
      >
        <span className="course-phase">
          {t(coursePhaseMessageKeys[item.phase])}
        </span>
        <span className="course-name">
          <span className="course-name-text">
            {renderUiText(item.exercise, t, formatNumber)}
          </span>
          {item.overrideStatus === "confirmed_next_normal" ? (
            <span className="course-confirmed-status">
              {t("fitness.plan.status.confirmed")}
            </span>
          ) : null}
        </span>
        <span className="course-metrics">
          <span className="course-prescription">
            {renderUiText(item.prescription, t, formatNumber)}
          </span>
          <span className="course-load">
            {renderUiText(item.loadGuidance, t, formatNumber)}
          </span>
          <span className="course-effort">
            {renderUiText(item.effort, t, formatNumber)}
          </span>
        </span>
        {notice ? (
          <span className="course-notice" role="note">
            <WarningCircle size={15} weight="fill" aria-hidden="true" />
            <strong>{t("fitness.course.attention")}</strong>
            <span>{notice}</span>
          </span>
        ) : null}
        <CaretDown size={16} className="course-caret" aria-hidden="true" />
      </summary>
      <div className="course-row-detail">
        {item.detail.length > 0 ? (
          <p>
            {item.detail
              .map((detail) => renderUiText(detail, t, formatNumber))
              .join(" ")}
          </p>
        ) : null}
        {item.phaseId && item.slotId ? (
          <button
            type="button"
            onClick={(event) =>
              onChooseAlternative?.(item, event.currentTarget)
            }
          >
            {t("fitness.exercise.change")}
          </button>
        ) : null}
      </div>
    </details>
  );
}

type ExerciseSuggestion = {
  exercise: string;
  sources: Array<"routine" | "selection" | "history">;
  lastUsedAt: string | null;
  relevance: "same_slot" | "same_phase" | "same_category" | "other";
};

function exerciseSearchIdentity(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function TrainingExerciseDialog({
  item,
  plan,
  onClose,
  onSaved,
}: {
  item: CourseItem;
  plan: NonNullable<DashboardData["todayPlan"]>;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t, formatNumber } = useI18n();
  const dialogRef = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const [query, setQuery] = useState("");
  const [selectedExercise, setSelectedExercise] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<ExerciseSuggestion[]>([]);
  const [suggestionState, setSuggestionState] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSuggestions = useCallback(async (signal?: AbortSignal) => {
    try {
      const params = new URLSearchParams();
      if (item.phaseId) params.set("phaseId", item.phaseId);
      if (item.slotId) params.set("slotId", item.slotId);
      const search = params.toString();
      const response = await fetch(
        `/api/fitness/training-selections${search ? `?${search}` : ""}`,
        {
          cache: "no-store",
          signal,
        },
      );
      if (!response.ok) throw new Error("Exercise suggestions unavailable");
      const result = (await response.json()) as {
        items?: ExerciseSuggestion[];
      };
      if (signal?.aborted) return;
      setSuggestions(Array.isArray(result.items) ? result.items : []);
      setSuggestionState("ready");
    } catch {
      if (signal?.aborted) return;
      setSuggestionState("error");
    }
  }, [item.phaseId, item.slotId]);

  useEffect(() => {
    const controller = new AbortController();
    const request = window.setTimeout(
      () => void loadSuggestions(controller.signal),
      0,
    );
    return () => {
      window.clearTimeout(request);
      controller.abort();
    };
  }, [loadSuggestions]);

  useEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    titleRef.current?.focus();
    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === titleRef.current)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKeydown);
    return () => {
      document.removeEventListener("keydown", handleKeydown);
      document.body.style.overflow = overflow;
    };
  }, [onClose, saving]);

  const candidates = useMemo(() => {
    const unique = new Map<string, ExerciseSuggestion>();
    for (const exercise of item.alternatives ?? []) {
      const identity = exerciseSearchIdentity(exercise);
      if (!identity || unique.has(identity)) continue;
      unique.set(identity, {
        exercise,
        sources: ["routine"],
        lastUsedAt: null,
        relevance: "same_slot",
      });
    }
    for (const suggestion of suggestions) {
      const identity = exerciseSearchIdentity(suggestion.exercise);
      if (!identity || unique.has(identity)) continue;
      unique.set(identity, suggestion);
    }
    return [...unique.values()].filter(
      (candidate) =>
        exerciseSearchIdentity(candidate.exercise) !==
        exerciseSearchIdentity(item.exerciseKey ?? ""),
    );
  }, [item.alternatives, item.exerciseKey, suggestions]);

  const visibleCandidates = useMemo(() => {
    const search = exerciseSearchIdentity(query);
    return candidates
      .map((candidate) => ({
        ...candidate,
        display: renderUiText(
          exerciseText(candidate.exercise),
          t,
          formatNumber,
        ),
      }))
      .filter(
        (candidate) => {
          if (!search) return candidate.relevance !== "other";
          return (
            exerciseSearchIdentity(candidate.exercise).includes(search) ||
            exerciseSearchIdentity(candidate.display).includes(search)
          );
        },
      )
      .sort((left, right) => {
        if (!search) return 0;
        const leftStarts =
          exerciseSearchIdentity(left.exercise).startsWith(search) ||
          exerciseSearchIdentity(left.display).startsWith(search);
        const rightStarts =
          exerciseSearchIdentity(right.exercise).startsWith(search) ||
          exerciseSearchIdentity(right.display).startsWith(search);
        return Number(rightStarts) - Number(leftStarts);
      })
      .slice(0, 8);
  }, [candidates, formatNumber, query, t]);

  const exactCandidate = useMemo(() => {
    const search = exerciseSearchIdentity(query);
    if (!search) return null;
    const explicitlySelected = selectedExercise
      ? candidates.find(
          (candidate) =>
            exerciseSearchIdentity(candidate.exercise) ===
            exerciseSearchIdentity(selectedExercise),
        )
      : null;
    if (explicitlySelected) return explicitlySelected;
    return (
      candidates.find((candidate) => {
        const display = renderUiText(
          exerciseText(candidate.exercise),
          t,
          formatNumber,
        );
        return (
          exerciseSearchIdentity(candidate.exercise) === search ||
          exerciseSearchIdentity(display) === search
        );
      }) ?? null
    );
  }, [candidates, formatNumber, query, selectedExercise, t]);
  const exercise = exactCandidate?.exercise ?? query.trim();
  const currentDisplay = renderUiText(item.exercise, t, formatNumber);
  const canSave =
    exercise.length > 0 &&
    exerciseSearchIdentity(exercise) !==
      exerciseSearchIdentity(item.exerciseKey ?? "") &&
    (exactCandidate !== null ||
      exerciseSearchIdentity(query) !==
        exerciseSearchIdentity(currentDisplay)) &&
    !saving;

  async function saveSelection() {
    if (!item.phaseId || !item.slotId || !canSave) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/fitness/training-selections", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": clientUuid(),
        },
        body: JSON.stringify({
          phaseId: item.phaseId,
          slotId: item.slotId,
          exercise,
          scope: "date",
          date: plan.planningDate,
        }),
      });
      if (!response.ok) {
        setError(t("fitness.exercise.failed"));
        return;
      }
      await onSaved();
      onClose();
    } catch {
      setError(t("fitness.exercise.failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="training-exercise-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="training-exercise-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="training-exercise-title"
      >
        <header>
          <div>
            <h2 id="training-exercise-title" ref={titleRef} tabIndex={-1}>
              {t("fitness.exercise.change")}
            </h2>
            <span>
              {t("fitness.exercise.current", {
                exercise: renderUiText(item.exercise, t, formatNumber),
              })}
            </span>
          </div>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={onClose}
            disabled={saving}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div className="training-exercise-body">
          <label className="training-exercise-search">
            <span>{t("fitness.exercise.searchLabel")}</span>
            <span className="training-exercise-search-control">
              <MagnifyingGlass size={18} aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSelectedExercise(null);
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || !canSave) return;
                  event.preventDefault();
                  void saveSelection();
                }}
                placeholder={t("fitness.exercise.searchPlaceholder")}
                maxLength={120}
                autoComplete="off"
                enterKeyHint="done"
              />
            </span>
          </label>

          <div
            className="training-exercise-results"
            role="group"
            aria-label={t("fitness.exercise.resultsAria")}
          >
            {suggestionState === "loading" ? (
              <p className="training-exercise-state" role="status">
                {t("fitness.exercise.loading")}
              </p>
            ) : null}
            {suggestionState === "error" ? (
              <div className="training-exercise-state is-error" role="status">
                <span>{t("fitness.exercise.suggestionsFailed")}</span>
                <button
                  type="button"
                  onClick={() => {
                    setSuggestionState("loading");
                    void loadSuggestions();
                  }}
                >
                  {t("fitness.exercise.retry")}
                </button>
              </div>
            ) : null}
            {visibleCandidates.map((candidate) => (
              <button
                key={candidate.exercise}
                type="button"
                className={
                  exactCandidate?.exercise === candidate.exercise
                    ? "is-selected"
                    : undefined
                }
                onClick={() => {
                  setQuery(candidate.display);
                  setSelectedExercise(candidate.exercise);
                  setError(null);
                }}
                aria-pressed={exactCandidate?.exercise === candidate.exercise}
              >
                <span>{candidate.display}</span>
                {exactCandidate?.exercise === candidate.exercise ? (
                  <CheckCircle size={18} weight="fill" aria-hidden="true" />
                ) : null}
              </button>
            ))}
            {suggestionState === "ready" &&
            visibleCandidates.length === 0 &&
            !query.trim() ? (
              <p className="training-exercise-state">
                {t("fitness.exercise.empty")}
              </p>
            ) : null}
            {query.trim() && !exactCandidate ? (
              <p className="training-exercise-custom" role="status">
                {t("fitness.exercise.custom", { exercise: query.trim() })}
              </p>
            ) : null}
          </div>
          {error ? <p className="training-exercise-error" role="alert">{error}</p> : null}
        </div>
        <footer>
          <button type="button" className="secondary-button" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </button>
          <button type="button" className="primary-button" onClick={saveSelection} disabled={!canSave}>
            {saving
              ? t("fitness.exercise.applying")
              : t("fitness.exercise.applyOnce")}
          </button>
        </footer>
      </section>
    </div>
  );
}

function planDecisionKey(
  code: NonNullable<DashboardData["todayPlan"]>["decisionCode"],
) {
  const keys = {
    ready: "fitness.decision.ready",
    recover_first: "fitness.decision.recover_first",
    reduce: "fitness.decision.reduce",
    recovery_day: "fitness.decision.recovery_day",
    baseline_required: "fitness.decision.baseline_required",
  } satisfies Record<
    NonNullable<DashboardData["todayPlan"]>["decisionCode"],
    string
  >;
  return keys[code];
}

function planConfidenceKey(
  confidence: NonNullable<DashboardData["todayPlan"]>["confidence"],
) {
  return {
    high: "fitness.confidence.high",
    medium: "fitness.confidence.medium",
    low: "fitness.confidence.low",
  }[confidence];
}

function LatestSessionReview({ data }: { data: DashboardData }) {
  const { t, formatDate, formatNumber } = useI18n();
  const session = data.latestStrength;
  const review = data.latestReview;
  if (!session || !review) return null;
  const phaseMessageKey = standardPhaseMessageKey(session.title);
  const sessionTitle = phaseMessageKey ? t(phaseMessageKey) : session.title;
  const isMultiSession = review.segments.length > 1;
  return (
    <details className="latest-session-review">
      <summary>
        <span>
          <small>
            {t(
              session.localDate === data.trainingSchedule.planningDate
                ? "fitness.review.todayStrength"
                : "fitness.review.latestStrength",
              {
                title: sessionTitle,
                date: formatDate(session.startedAt, {
                  timeZone: data.profile?.timezone ?? DEFAULT_TIMEZONE,
                  month: "numeric",
                  day: "numeric",
                }),
              },
            )}
          </small>
          <strong>{renderUiText(review.summary, t, formatNumber)}</strong>
          {review.overview ? (
            <span className="review-multi-overview">
              {renderUiText(review.overview, t, formatNumber)}
            </span>
          ) : null}
        </span>
        <span className="review-summary-facts">
          {isMultiSession
            ? null
            : t("fitness.minutes", {
                count: formatNumber(Math.round(session.durationMinutes)),
              })}
          <CaretDown size={16} aria-hidden="true" />
        </span>
      </summary>
      <div className="review-body">
        {isMultiSession ? (
          <section
            className="review-segment-section"
            aria-label={t("fitness.review.segment.section")}
          >
            <h3>{t("fitness.review.segment.section")}</h3>
            <ol>
              {review.segments.map((segment, index) => (
                <li key={segment.sessionId}>
                  <span className="review-segment-label">
                    {t("fitness.review.segment.number", {
                      count: formatNumber(index + 1),
                    })}
                  </span>
                  <span className="review-segment-content">
                    <strong>
                      {renderUiText(segment.venue, t, formatNumber)}
                    </strong>
                    <small>
                      {segment.timePrecision === "exact" ? (
                        <>
                          <time
                            dateTime={
                              segment.startedAtUtc ?? segment.startedAt
                            }
                          >
                            {formatDate(
                              segment.startedAtUtc ?? segment.startedAt,
                              {
                                timeZone:
                                  data.profile?.timezone ?? DEFAULT_TIMEZONE,
                                hour: "numeric",
                                minute: "2-digit",
                              },
                            )}
                          </time>
                          <span aria-hidden="true"> · </span>
                        </>
                      ) : null}
                      {t("fitness.review.segment.facts", {
                        minutes: formatNumber(
                          Math.round(segment.durationMinutes),
                        ),
                        setCount: formatNumber(segment.totalSets),
                      })}
                    </small>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
        <div className="review-sections">
          {review.sections.map((section) => (
            <section key={section.title}>
              <h3>{t(reviewSectionMessageKeys[section.title])}</h3>
              <ul>
                {section.lines.map((line) => (
                  <li key={uiTextKey(line)}>
                    {renderUiText(line, t, formatNumber)}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </details>
  );
}

function TodayView({
  data,
  displayName,
  deviceNow,
  recordNow,
  onScheduleChanged,
  onOpenSettings,
  onOpenLog,
}: {
  data: DashboardData;
  displayName: string;
  deviceNow: Date | null;
  recordNow: Date;
  onScheduleChanged: () => Promise<void>;
  onOpenSettings: () => void;
  onOpenLog: () => void;
}) {
  const { t, formatDate, formatNumber } = useI18n();
  const plan = data.todayPlan;
  const schedule = data.trainingSchedule;
  const timezone = data.profile?.timezone ?? DEFAULT_TIMEZONE;
  const exerciseTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [exerciseSelection, setExerciseSelection] = useState<CourseItem | null>(
    null,
  );
  const openExerciseSelection = useCallback(
    (item: CourseItem, trigger: HTMLButtonElement) => {
      exerciseTriggerRef.current = trigger;
      setExerciseSelection(item);
    },
    [],
  );
  const closeExerciseSelection = useCallback(() => {
    setExerciseSelection(null);
    requestAnimationFrame(() => exerciseTriggerRef.current?.focus());
  }, []);

  if (schedule.status === "paused" && schedule.pause) {
    const isOneDayPause =
      schedule.pause.resumeOn ===
      addIsoDateDays(schedule.pause.startsOn, 1);
    const title = isOneDayPause
      ? schedule.nextPhase?.kind === "recovery"
        ? t("fitness.pause.extendRecovery")
        : t("fitness.pause.restToday")
      : t("fitness.pause.title");
    const greeting = deviceNow
      ? t(greetingKeyForDevice(deviceNow, timezone))
      : t("fitness.greeting.hello");
    return (
      <div className="today-view">
        <section className="today-decision training-pause-card">
          <div className="today-kicker">
            <span>{t("fitness.greeting.named", { greeting, name: displayName })}</span>
            <span>
              {formatDate(recordNow, {
                timeZone: timezone,
                month: "long",
                day: "numeric",
                weekday: "long",
              })}
            </span>
          </div>
          <span className="decision-status">
            <Info size={16} weight="fill" aria-hidden="true" />
            {t("fitness.pause.status")}
          </span>
          <h1>{title}</h1>
          <div className="training-pause-summary">
            <span>
              {schedule.pause.resumeOn
                ? t("fitness.pause.resumeOn", {
                    date: formatDate(schedule.pause.resumeOn, {
                      month: "numeric",
                      day: "numeric",
                      weekday: "short",
                    }),
                  })
                : t("fitness.pause.noResumeDate")}
            </span>
            <span>
              {t("fitness.pause.next", {
                phase: schedule.nextPhase?.raw ?? t("fitness.pause.pending"),
              })}
            </span>
          </div>
          <TrainingScheduleControls
            schedule={schedule}
            variant="resume"
            onChanged={onScheduleChanged}
          />
        </section>
        <LatestSessionReview data={data} />
      </div>
    );
  }

  if (!plan) {
    return (
      <section className="empty-panel">
        <Info size={24} aria-hidden="true" />
        <h1>{t("fitness.empty.baselineTitle")}</h1>
        <p>{t("fitness.empty.baselineBody")}</p>
        <div className="empty-panel-actions">
          <button type="button" className="primary-button" onClick={onOpenLog}>
            {t("fitness.empty.recordFirst")}
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={onOpenSettings}
          >
            {t("fitness.empty.setupCycle")}
          </button>
        </div>
      </section>
    );
  }

  const decisionTone =
    plan.decisionCode === "recover_first" ||
    plan.decisionCode === "reduce" ||
    plan.decisionCode === "baseline_required"
      ? "watch"
      : "ready";
  const greeting = deviceNow
    ? t(greetingKeyForDevice(deviceNow, timezone))
    : t("fitness.greeting.hello");
  const confidence = t(planConfidenceKey(plan.confidence));
  const duration = plan.durationMinutes
    ? t("fitness.duration.range", {
        minimum: formatNumber(plan.durationMinutes.minimum),
        maximum: formatNumber(plan.durationMinutes.maximum),
      })
    : t("fitness.duration.flexible");
  const referenceContext = plan.referenceContext
    ? renderUiText(plan.referenceContext, t, formatNumber)
    : null;
  const plannedIntentLabel =
    plan.sessionIntent === "normal"
      ? null
      : t(`fitness.intent.${plan.sessionIntent}`);
  const phaseMessageKey = standardPhaseMessageKey(plan.phaseLabel);
  const phaseLabel = phaseMessageKey ? t(phaseMessageKey) : plan.phaseLabel;

  return (
    <div className="today-view">
      <section className="today-decision">
        <div className="today-kicker">
          <span>{t("fitness.greeting.named", { greeting, name: displayName })}</span>
          <div className="today-date-actions">
            <span>
              {formatDate(recordNow, {
                timeZone: timezone,
                month: "long",
                day: "numeric",
                weekday: "long",
              })}
            </span>
            <TrainingScheduleControls
              schedule={schedule}
              onChanged={onScheduleChanged}
            />
          </div>
        </div>

        <div className="decision-title-row">
          <div className="decision-status-row">
            <span className={`decision-status decision-status-${decisionTone}`}>
              {decisionTone === "ready" ? (
                <CheckCircle size={16} weight="fill" aria-hidden="true" />
              ) : (
                <WarningCircle size={16} weight="fill" aria-hidden="true" />
              )}
              {t(planDecisionKey(plan.decisionCode))}
            </span>
            {plannedIntentLabel ? (
              <span className="decision-session-mode">
                {plannedIntentLabel}
              </span>
            ) : null}
          </div>
          <h1>
            {plan.decisionCode === "recover_first"
              ? t("fitness.today.recoveryPriority")
              : phaseLabel}
          </h1>
          <div className="duration">
            <Clock size={18} aria-hidden="true" />
            <span>{duration}</span>
          </div>
        </div>

        <ul
          className="health-briefing"
          aria-label={t("fitness.today.briefingAria")}
        >
          {plan.briefing.map((line) => (
            <li key={uiTextKey(line)}>
              {renderUiText(line, t, formatNumber)}
            </li>
          ))}
        </ul>
      </section>

      <LatestSessionReview data={data} />

      <section className="course-panel">
        <div className="course-heading">
          <div>
            <h2>{t("fitness.course.title")}</h2>
            <span>{t("fitness.course.subtitle")}</span>
          </div>
          <span className="course-confidence">
            {plan.referenceDate
              ? t(
                  referenceContext
                    ? "fitness.course.referenceContext"
                    : "fitness.course.reference",
                  {
                    date: formatDate(plan.referenceDate, {
                      month: "numeric",
                      day: "numeric",
                    }),
                    ...(referenceContext
                      ? { context: referenceContext }
                      : {}),
                  },
                )
              : t("fitness.course.confidence", { confidence })}
          </span>
        </div>

        <div className="course-column-labels" aria-hidden="true">
          <span>{t("fitness.course.exercise")}</span>
          <span>{t("fitness.course.sets")}</span>
          <span>{t("fitness.course.load")}</span>
          <span>{t("fitness.course.effort")}</span>
        </div>

        <div className="course-list">
          {plan.items.map((item, index) => (
            <Fragment key={courseItemKey(item)}>
              {index === 0 || plan.items[index - 1]?.phase !== item.phase ? (
                <h3 className="course-phase-group">
                  {t(coursePhaseMessageKeys[item.phase])}
                </h3>
              ) : null}
              <CourseRow
                item={item}
                onChooseAlternative={openExerciseSelection}
              />
            </Fragment>
          ))}
        </div>

        <details className="course-rationale">
          <summary>{t("fitness.course.rationale")}</summary>
          <p>
            {plan.referenceDate
              ? t(
                  referenceContext
                    ? "fitness.course.rationaleReferenceContext"
                    : "fitness.course.rationaleReference",
                  {
                    date: formatDate(plan.referenceDate, {
                      month: "numeric",
                      day: "numeric",
                    }),
                    confidence,
                    ...(referenceContext
                      ? { context: referenceContext }
                      : {}),
                  },
                )
              : t("fitness.course.rationaleNoReference", { confidence })}
          </p>
        </details>
      </section>
      {exerciseSelection ? (
        <TrainingExerciseDialog
          item={exerciseSelection}
          plan={plan}
          onClose={closeExerciseSelection}
          onSaved={onScheduleChanged}
        />
      ) : null}
    </div>
  );
}

function ProgressView({ data }: { data: DashboardData }) {
  const { t, formatNumber } = useI18n();
  const progress = data.progress;
  const [kind, setKind] = useState<ProgressKind>("body");
  const [range, setRange] = useState<Range>(30);

  if (!progress) {
    return (
      <section className="empty-panel">
        <ChartLineUp size={24} aria-hidden="true" />
        <h1>{t("fitness.progress.emptyTitle")}</h1>
        <p>{t("fitness.progress.emptyBody")}</p>
      </section>
    );
  }

  const selectedSeries = progress.series[kind];

  return (
    <div className="progress-view">
      <section className="progress-summary">
        <span>{t("fitness.progress.eyebrow")}</span>
        <h1>{renderUiText(progress.verdict, t, formatNumber)}</h1>
        <div className="progress-metrics">
          {progress.metrics.map((metric) => (
            <div key={uiTextKey(metric.label)}>
              <span>{renderUiText(metric.label, t, formatNumber)}</span>
              <strong>{renderUiText(metric.value, t, formatNumber)}</strong>
              <small className={`metric-${metric.tone}`}>
                {renderUiText(metric.change, t, formatNumber)}
              </small>
            </div>
          ))}
        </div>
      </section>

      <section className="chart-panel">
        <div className="chart-controls">
          <div
            className="segmented-control"
            role="group"
            aria-label={t("fitness.progress.kindAria")}
          >
            {(["body", "strength", "cardio"] as const).map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={kind === id}
                className={kind === id ? "is-active" : ""}
                onClick={() => setKind(id)}
              >
                {renderUiText(progress.series[id].label, t, formatNumber)}
              </button>
            ))}
          </div>

          <div
            className="range-control"
            role="group"
            aria-label={t("fitness.progress.rangeAria")}
          >
            {(
              [
                [30, "fitness.progress.range30"],
                [90, "fitness.progress.range90"],
                ["all", "fitness.progress.rangeAll"],
              ] as Array<[Range, string]>
            ).map(([id, labelKey]) => (
              <button
                key={String(id)}
                type="button"
                aria-pressed={range === id}
                className={range === id ? "is-active" : ""}
                onClick={() => setRange(id)}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
        </div>

        <ProgressChart
          key={`${kind}-${range}`}
          series={selectedSeries}
          range={range}
          anchorDate={data.dataCutoff}
        />
      </section>

      <section className="agent-insights">
        <div className="insight-heading">
          <Info size={18} aria-hidden="true" />
          <h2>{t("fitness.progress.insights")}</h2>
        </div>
        <ul>
          {progress.insights.map((insight) => (
            <li key={uiTextKey(insight)}>
              {renderUiText(insight, t, formatNumber)}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export function FitnessApp({
  data,
  displayName,
  requestedAt,
  initialTab = "today",
  initialNutritionDate,
}: {
  data: DashboardData;
  displayName: string;
  requestedAt: string;
  initialTab?: Tab;
  initialNutritionDate?: string;
}) {
  const { t, formatDate } = useI18n();
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const [dashboard, setDashboard] = useState(data);
  const [deviceNow, setDeviceNow] = useState<Date | null>(null);
  const [nutritionDate, setNutritionDate] = useState(
    initialNutritionDate,
  );
  const [historyEpoch, setHistoryEpoch] = useState(0);
  const [profileSettingsOpen, setProfileSettingsOpen] = useState(
    data.profile?.setupCompleted === false,
  );
  const revisionRef = useRef<{ today: string | null; progress: string | null }>(
    { today: null, progress: null },
  );
  const snapshotSequence = useRef(0);
  const dashboardStatusRef = useRef(data.status);
  const pendingScrollTop = useRef<number | null>(null);
  const scrollPositions = useRef<Record<Tab, number>>({
    today: 0,
    nutrition: 0,
    progress: 0,
    log: 0,
  });

  const refreshDashboard = useCallback(async () => {
    const response = await fetch("/api/fitness/snapshot", {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(t("fitness.error.refreshToday"));
    const result = (await response.json()) as { dashboard: DashboardData };
    if (result.dashboard.status === "unavailable") {
      throw new Error(t("fitness.error.databaseUnavailable"));
    }
    dashboardStatusRef.current = result.dashboard.status;
    setDashboard(result.dashboard);
  }, [t]);

  function readLocation() {
    const params = new URLSearchParams(window.location.search);
    const requestedTab = params.get("tab");
    const tab: Tab =
      requestedTab === "nutrition" ||
      requestedTab === "progress" ||
      requestedTab === "log"
        ? requestedTab
        : "today";
    const date = params.get("date");
    return {
      tab,
      date:
        date && isIsoDate(date)
          ? date
          : undefined,
    };
  }

  function writeLocation(tab: Tab, date = nutritionDate) {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    if (date) url.searchParams.set("date", date);
    else url.searchParams.delete("date");
    window.history.pushState(null, "", url);
  }

  function changeTab(nextTab: Tab) {
    if (nextTab === activeTab) return;
    scrollPositions.current[activeTab] = window.scrollY;
    pendingScrollTop.current = scrollPositions.current[nextTab];
    setActiveTab(nextTab);
    writeLocation(nextTab);
  }

  useLayoutEffect(() => {
    if (pendingScrollTop.current === null) return;
    const top = pendingScrollTop.current;
    pendingScrollTop.current = null;
    window.scrollTo({ top });
  }, [activeTab, historyEpoch]);

  useEffect(() => {
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    return () => {
      window.history.scrollRestoration = previous;
    };
  }, []);

  useEffect(() => {
    function syncDeviceClock() {
      setDeviceNow(new Date());
    }
    function handleVisibility() {
      if (document.visibilityState === "visible") syncDeviceClock();
    }
    syncDeviceClock();
    const timer = window.setInterval(syncDeviceClock, 30_000);
    window.addEventListener("focus", syncDeviceClock);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", syncDeviceClock);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let checking = false;

    async function checkForUpdates() {
      if (checking || document.visibilityState === "hidden") return;
      checking = true;
      try {
        const revisionResponse = await fetch("/api/fitness/revisions", {
          cache: "no-store",
        });
        if (!revisionResponse.ok) return;
        const revisionResult = (await revisionResponse.json()) as {
          revisions: { today: string; progress: string };
        };
        if (disposed) return;
        const nextRevisions = revisionResult.revisions;
        if (
          revisionRef.current.today === null ||
          revisionRef.current.progress === null
        ) {
          revisionRef.current = {
            today: nextRevisions.today,
            progress: nextRevisions.progress,
          };
          if (dashboardStatusRef.current !== "unavailable") return;
        }
        if (activeTab === "nutrition" || activeTab === "log") return;
        const revisionChanged =
          activeTab === "today"
            ? revisionRef.current.today !== nextRevisions.today
            : revisionRef.current.progress !== nextRevisions.progress;
        if (!revisionChanged && dashboardStatusRef.current !== "unavailable") {
          return;
        }

        const sequence = ++snapshotSequence.current;
        const snapshotResponse = await fetch("/api/fitness/snapshot", {
          cache: "no-store",
        });
        if (!snapshotResponse.ok) return;
        const snapshotResult = (await snapshotResponse.json()) as {
          dashboard: DashboardData;
        };
        if (
          disposed ||
          sequence !== snapshotSequence.current ||
          snapshotResult.dashboard.status === "unavailable"
        ) {
          return;
        }
        dashboardStatusRef.current = snapshotResult.dashboard.status;
        setDashboard(snapshotResult.dashboard);
        revisionRef.current = {
          today: nextRevisions.today,
          progress: nextRevisions.progress,
        };
      } catch {
        // Keep the last verified dashboard state and retry on the next check.
      } finally {
        checking = false;
      }
    }

    function handleVisibility() {
      if (document.visibilityState === "visible") void checkForUpdates();
    }
    void checkForUpdates();
    if (activeTab === "nutrition" || activeTab === "log") {
      return () => {
        disposed = true;
      };
    }
    const timer = window.setInterval(checkForUpdates, 45_000);
    window.addEventListener("focus", checkForUpdates);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", checkForUpdates);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [activeTab]);

  useEffect(() => {
    function handlePopState() {
      scrollPositions.current[activeTab] = window.scrollY;
      const next = readLocation();
      pendingScrollTop.current = scrollPositions.current[next.tab];
      setActiveTab(next.tab);
      setNutritionDate(next.date);
      setHistoryEpoch((value) => value + 1);
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [activeTab]);

  const dashboardMessage =
    dashboard.status === "unavailable"
      ? t("fitness.error.databaseUnavailable")
      : dashboard.status === "empty" &&
          dashboard.trainingSchedule.status !== "paused"
        ? t("fitness.state.awaitingFirstRecord")
        : null;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-inner">
          <div className="brand-lockup">
            <div className="brand-mark" aria-hidden="true">
              OF
            </div>
            <div>
              <strong>Open Fitness</strong>
              <span>{t("fitness.brand.tagline")}</span>
            </div>
          </div>
          <nav className="desktop-nav" aria-label={t("fitness.nav.main")}>
            {navigation.map((item) => {
              const active = activeTab === item.id;
              return (
                <button
                  type="button"
                  key={item.id}
                  className={active ? "is-active" : ""}
                  aria-current={active ? "page" : undefined}
                  onClick={() => changeTab(item.id)}
                >
                  {t(item.labelKey)}
                </button>
              );
            })}
          </nav>
          <div className="header-account">
            <span className="sync-label">
              {t("fitness.header.dataThrough", {
                date: dashboard.dataCutoff
                  ? formatDate(dashboard.dataCutoff, {
                      ...(!isIsoDate(dashboard.dataCutoff)
                        ? {
                            timeZone:
                              dashboard.profile?.timezone ?? DEFAULT_TIMEZONE,
                          }
                        : {}),
                      month: "numeric",
                      day: "numeric",
                    })
                  : t("common.noData"),
              })}
            </span>
            <button
              className="header-settings"
              type="button"
              aria-label={t("fitness.header.settings")}
              onClick={() => setProfileSettingsOpen(true)}
            >
              <GearSix size={18} aria-hidden="true" />
            </button>
            <form action="/auth/logout" method="post">
              <button className="header-logout" type="submit">
                {t("fitness.header.logout")}
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="app-main">
        {dashboardMessage ? (
          <div
            className={`state-message state-${dashboard.status}`}
            role={dashboard.status === "unavailable" ? "alert" : "status"}
          >
            {dashboardMessage}
          </div>
        ) : null}

        <div className="tab-stage">
          <Activity mode={activeTab === "today" ? "visible" : "hidden"}>
            <div
              className={`tab-panel${activeTab === "today" ? " is-active" : ""}`}
              data-tab="today"
            >
              <TodayView
                data={dashboard}
                displayName={dashboard.profile?.displayName || displayName}
                deviceNow={deviceNow}
                recordNow={deviceNow ?? new Date(requestedAt)}
                onScheduleChanged={refreshDashboard}
                onOpenSettings={() => setProfileSettingsOpen(true)}
                onOpenLog={() => changeTab("log")}
              />
            </div>
          </Activity>

          <Activity mode={activeTab === "nutrition" ? "visible" : "hidden"}>
            <div
              className={`tab-panel${activeTab === "nutrition" ? " is-active" : ""}`}
              data-tab="nutrition"
            >
              <NutritionView
                active={activeTab === "nutrition"}
                initialDate={nutritionDate}
                timezone={dashboard.profile?.timezone ?? DEFAULT_TIMEZONE}
                onDateChange={(date) => {
                  setNutritionDate(date);
                  writeLocation("nutrition", date);
                }}
              />
            </div>
          </Activity>

          <Activity mode={activeTab === "progress" ? "visible" : "hidden"}>
            <div
              className={`tab-panel${activeTab === "progress" ? " is-active" : ""}`}
              data-tab="progress"
            >
              <ProgressView data={dashboard} />
            </div>
          </Activity>

          <Activity mode={activeTab === "log" ? "visible" : "hidden"}>
            <div
              className={`tab-panel${activeTab === "log" ? " is-active" : ""}`}
              data-tab="log"
            >
              <LogView
                active={activeTab === "log"}
                initialDate={nutritionDate}
                timezone={dashboard.profile?.timezone ?? DEFAULT_TIMEZONE}
                cycle={dashboard.trainingSchedule.cycle}
                nextPhase={dashboard.trainingSchedule.nextPhase}
                onDateChange={(date) => {
                  setNutritionDate(date);
                  writeLocation("log", date);
                }}
                onDataChanged={async () => {
                  await refreshDashboard();
                }}
                onOpenNutrition={() => changeTab("nutrition")}
              />
            </div>
          </Activity>
        </div>
      </main>

      <nav className="mobile-nav" aria-label={t("fitness.nav.main")}>
        {navigation.map((item) => {
          const Icon = item.icon;
          const active = activeTab === item.id;
          return (
            <button
              type="button"
              key={item.id}
              className={active ? "is-active" : ""}
              aria-current={active ? "page" : undefined}
              onClick={() => changeTab(item.id)}
            >
              <Icon
                size={22}
                weight={active ? "fill" : "regular"}
                aria-hidden="true"
              />
              <span>{t(item.labelKey)}</span>
            </button>
          );
        })}
      </nav>
      <ProfileSettingsDialog
        open={profileSettingsOpen}
        onOpenChange={setProfileSettingsOpen}
        onSaved={() => {
          void refreshDashboard();
        }}
      />
    </div>
  );
}
