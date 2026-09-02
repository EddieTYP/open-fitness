"use client";

import {
  ArrowLeft,
  Barbell,
  CalendarBlank,
  CaretLeft,
  CaretRight,
  CheckCircle,
  ForkKnife,
  Heart,
  Plus,
  Scales,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  BodyLogForm,
  RecoveryLogForm,
  WorkoutLogForm,
  type LogFormKind,
} from "@/components/log/LogForms";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { Translator } from "@/lib/i18n/catalog";
import { renderUiText, type UiText } from "@/lib/i18n/ui-text";
import type { CyclePhase } from "@/lib/training-cycle";
import { dateInTimeZone, timeInTimeZone } from "@/lib/timezone.mjs";

type AddLogFormKind = Exclude<LogFormKind, "meal">;

type FitnessLogRecord = {
  id: string;
  kind: LogFormKind;
  occurredAt: string | null;
  recordedAt: string;
  timePrecision: "exact" | "minute" | "date_only";
  title: UiText;
  summary: UiText | null;
  metrics: UiText[];
  intent?: "normal" | "deload" | "test";
};

type LogResponse = {
  date: string;
  records: FitnessLogRecord[];
  truncated: boolean;
  error?: string;
};

function recordKinds(t: Translator) {
  return [
  {
    id: "workout" as const,
    label: t("log.kind.workout"),
    description: t("log.kind.workoutDescription"),
    icon: Barbell,
  },
  {
    id: "body" as const,
    label: t("log.kind.body"),
    description: t("log.kind.bodyDescription"),
    icon: Scales,
  },
  {
    id: "recovery" as const,
    label: t("log.kind.recovery"),
    description: t("log.kind.recoveryDescription"),
    icon: Heart,
  },
  {
    id: "meal" as const,
    label: t("log.kind.meal"),
    description: t("log.kind.mealDescription"),
    icon: ForkKnife,
  },
  ];
}

function addDateDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function formatSelectedDate(
  date: string,
  formatDate: ReturnType<typeof useI18n>["formatDate"],
) {
  return formatDate(date, {
    month: "long",
    day: "numeric",
    weekday: "short",
  });
}

function formatLogTime(
  record: FitnessLogRecord,
  timezone: string,
  t: Translator,
  formatTime: ReturnType<typeof useI18n>["formatTime"],
) {
  if (!record.occurredAt || record.timePrecision === "date_only") {
    return t("log.time.unknown");
  }
  return formatTime(record.occurredAt, {
    timeZone: timezone,
    hourCycle: "h23",
  });
}

function getKind(record: FitnessLogRecord, kinds: ReturnType<typeof recordKinds>) {
  return kinds.find((kind) => kind.id === record.kind) ?? kinds[0];
}

export function LogView({
  active,
  initialDate,
  timezone,
  cycle,
  nextPhase,
  onDateChange,
  onDataChanged,
  onOpenNutrition,
}: {
  active: boolean;
  initialDate?: string;
  timezone: string;
  cycle: CyclePhase[];
  nextPhase: CyclePhase | null;
  onDateChange: (date: string) => void;
  onDataChanged: () => Promise<void>;
  onOpenNutrition: () => void;
}) {
  const { t, formatDate, formatNumber, formatTime } = useI18n();
  const kinds = recordKinds(t);
  const today = dateInTimeZone(new Date(), timezone);
  const [selectedDate, setSelectedDate] = useState(
    initialDate && initialDate <= today ? initialDate : today,
  );
  const [records, setRecords] = useState<FitnessLogRecord[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [formKind, setFormKind] = useState<AddLogFormKind | null>(null);
  const dirty = useRef(false);
  const requestSequence = useRef(0);
  const sheetTitle = useRef<HTMLHeadingElement>(null);
  const sheetPanel = useRef<HTMLElement>(null);
  const primaryTrigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const requestedExternalDate =
    initialDate && initialDate <= today ? initialDate : today;
  const [syncedExternalDate, setSyncedExternalDate] = useState(
    requestedExternalDate,
  );

  if (active && syncedExternalDate !== requestedExternalDate) {
    setSyncedExternalDate(requestedExternalDate);
    setLoading(true);
    setError(null);
    setSelectedDate(requestedExternalDate);
  }

  const loadRecords = useCallback(async (date: string) => {
    const sequence = ++requestSequence.current;
    try {
      const response = await fetch(`/api/fitness/log?date=${encodeURIComponent(date)}`, {
        cache: "no-store",
      });
      const result = (await response.json().catch(() => null)) as LogResponse | null;
      if (!response.ok || !result) {
        throw new Error(t("log.records.loadError"));
      }
      if (sequence !== requestSequence.current) return;
      setError(null);
      setRecords(result.records);
      setTruncated(result.truncated);
    } catch (caught) {
      if (sequence !== requestSequence.current) return;
      setRecords([]);
      setTruncated(false);
      setError(caught instanceof Error ? caught.message : t("log.records.loadError"));
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!active) return;
    let refreshing = false;
    async function refreshIfVisible() {
      if (refreshing || document.visibilityState === "hidden") return;
      refreshing = true;
      await loadRecords(selectedDate);
      refreshing = false;
    }
    const timer = window.setTimeout(() => void refreshIfVisible(), 0);
    const interval = window.setInterval(() => void refreshIfVisible(), 10_000);
    window.addEventListener("focus", refreshIfVisible);
    window.addEventListener("pageshow", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshIfVisible);
      window.removeEventListener("pageshow", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
      requestSequence.current += 1;
    };
  }, [active, loadRecords, selectedDate]);

  useEffect(() => {
    if (!success) return;
    const timer = window.setTimeout(() => setSuccess(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [success]);

  useEffect(() => {
    if (!sheetOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Tab") {
        const focusable = [...(
          sheetPanel.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
          ) ?? []
        )].filter((element) => element.getClientRects().length > 0);
        const first = focusable[0];
        const last = focusable.at(-1);
        const active = document.activeElement;
        if (!first || !last) {
          event.preventDefault();
          sheetTitle.current?.focus();
        } else if (
          event.shiftKey &&
          (active === first || active === sheetTitle.current || !sheetPanel.current?.contains(active))
        ) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || !sheetPanel.current?.contains(active))) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (dirty.current && !window.confirm(t("log.discard"))) return;
        dirty.current = false;
        setFormKind(null);
        setSheetOpen(false);
        restoreTriggerFocus();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [sheetOpen, t]);

  useEffect(() => {
    if (!sheetOpen) return;
    const frame = window.requestAnimationFrame(() => sheetTitle.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [formKind, sheetOpen]);

  function changeDate(date: string) {
    const boundedDate = date > today ? today : date;
    setLoading(true);
    setError(null);
    setSelectedDate(boundedDate);
    onDateChange(boundedDate);
  }

  function retryLoad() {
    setLoading(true);
    setError(null);
    void loadRecords(selectedDate);
  }

  function restoreTriggerFocus() {
    const target = returnFocus.current;
    window.requestAnimationFrame(() => {
      (target?.isConnected ? target : primaryTrigger.current)?.focus();
    });
  }

  function openSheet(event: ReactMouseEvent<HTMLButtonElement>) {
    returnFocus.current = event.currentTarget;
    setFormKind(null);
    dirty.current = false;
    setSheetOpen(true);
  }

  function requestClose() {
    if (dirty.current && !window.confirm(t("log.discard"))) return;
    dirty.current = false;
    setFormKind(null);
    setSheetOpen(false);
    restoreTriggerFocus();
  }

  function requestBack() {
    if (dirty.current && !window.confirm(t("log.discard"))) return;
    dirty.current = false;
    setFormKind(null);
  }

  function handleBackdrop(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) requestClose();
  }

  async function handleSaved(message: string) {
    dirty.current = false;
    setFormKind(null);
    setSheetOpen(false);
    setSuccess(message);
    restoreTriggerFocus();
    await Promise.allSettled([
      loadRecords(selectedDate),
      onDataChanged(),
    ]);
    restoreTriggerFocus();
  }

  const defaultTime = selectedDate === today
    ? timeInTimeZone(new Date(), timezone)
    : "12:00";
  const formTitle = formKind
    ? kinds.find((kind) => kind.id === formKind)?.label ?? t("log.addRecord")
    : t("log.addRecord");

  return (
    <div className="log-view">
      <header className="log-page-header">
        <div>
          <h1>{t("log.title")}</h1>
          <p>{formatSelectedDate(selectedDate, formatDate)}</p>
        </div>
        <button
          className="log-add-button"
          type="button"
          ref={primaryTrigger}
          onClick={openSheet}
        >
          <Plus size={17} weight="bold" aria-hidden="true" />
          {t("log.record")}
        </button>
      </header>

      <div className="log-date-control" aria-label={t("log.date.select")}>
        <button
          type="button"
          aria-label={t("log.date.previous")}
          onClick={() => changeDate(addDateDays(selectedDate, -1))}
        >
          <CaretLeft size={19} aria-hidden="true" />
        </button>
        <label>
          <CalendarBlank size={17} aria-hidden="true" />
          <span className="sr-only">{t("log.date.label")}</span>
          <input
            type="date"
            value={selectedDate}
            max={today}
            onChange={(event) => changeDate(event.target.value)}
          />
        </label>
        <button
          type="button"
          aria-label={t("log.date.next")}
          disabled={selectedDate >= today}
          onClick={() => changeDate(addDateDays(selectedDate, 1))}
        >
          <CaretRight size={19} aria-hidden="true" />
        </button>
      </div>

      {success ? (
        <div className="log-success" role="status">
          <CheckCircle size={18} weight="fill" aria-hidden="true" />
          {success}
        </div>
      ) : null}

      <section className="log-records" aria-label={t("log.records.label")} aria-busy={loading}>
        {loading ? (
          <div className="log-loading" aria-label={t("log.records.loading")}>
            <div className="skeleton" />
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
        ) : error ? (
          <div className="log-empty-state" role="alert">
            <WarningCircle size={24} aria-hidden="true" />
            <strong>{t("log.records.loadFailed")}</strong>
            <p>{error}</p>
            <button type="button" onClick={retryLoad}>
              {t("common.retry")}
            </button>
          </div>
        ) : records.length === 0 ? (
          <div className="log-empty-state">
            <CalendarBlank size={24} aria-hidden="true" />
            <strong>{t("log.records.empty")}</strong>
            <p>{t("log.records.emptyDescription")}</p>
            <button type="button" onClick={openSheet}>
              {t("log.records.first")}
            </button>
            <button type="button" onClick={onOpenNutrition}>
              {t("log.records.goNutrition")}
            </button>
          </div>
        ) : (
          <div className="log-record-list">
            {records.map((record) => {
              const kind = getKind(record, kinds);
              const Icon = kind.icon;
              return (
                <article className="log-record-row" key={`${record.kind}:${record.id}`}>
                  <div className={`log-record-icon is-${record.kind}`} aria-hidden="true">
                    <Icon size={19} weight="regular" />
                  </div>
                  <div className="log-record-content">
                    <div className="log-record-heading">
                      <div className="log-record-title">
                        <strong>{renderUiText(record.title, t, formatNumber)}</strong>
                        {record.kind === "workout" && record.intent !== undefined && record.intent !== "normal" ? (
                          <span className={`log-intent-badge is-${record.intent}`}>
                            {t(`log.record.intent.${record.intent}`)}
                          </span>
                        ) : null}
                      </div>
                      <time dateTime={record.occurredAt ?? selectedDate}>
                        {formatLogTime(record, timezone, t, formatTime)}
                      </time>
                    </div>
                    {record.summary ? (
                      <p>{renderUiText(record.summary, t, formatNumber)}</p>
                    ) : null}
                    {record.metrics.length > 0 ? (
                      <div className="log-record-metrics">
                        {record.metrics.map((item, index) => (
                          <span key={`${record.id}:metric:${index}`}>
                            {renderUiText(item, t, formatNumber)}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {truncated ? (
        <p className="log-truncated">{t("log.records.truncated")}</p>
      ) : null}

      {sheetOpen ? (
        <div
          className="log-sheet-backdrop"
          onPointerDown={handleBackdrop}
          role="presentation"
        >
          <section
            className="log-sheet"
            ref={sheetPanel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="log-sheet-title"
          >
            <header className="log-sheet-header">
              {formKind ? (
                <button type="button" aria-label={t("log.sheet.back")} onClick={requestBack}>
                  <ArrowLeft size={19} aria-hidden="true" />
                </button>
              ) : (
                <span className="log-sheet-spacer" aria-hidden="true" />
              )}
              <div>
                <h2 id="log-sheet-title" ref={sheetTitle} tabIndex={-1}>
                  {formTitle}
                </h2>
                <span>{formatSelectedDate(selectedDate, formatDate)}</span>
              </div>
              <button type="button" aria-label={t("common.close")} onClick={requestClose}>
                <X size={19} aria-hidden="true" />
              </button>
            </header>
            <div className="log-sheet-body">
              {!formKind ? (
                <div className="log-kind-list">
                  {kinds.filter((kind) => kind.id !== "meal").map((kind) => {
                    const Icon = kind.icon;
                    return (
                      <button
                        type="button"
                        key={kind.id}
                        onClick={() => setFormKind(kind.id as AddLogFormKind)}
                      >
                        <span className={`log-kind-icon is-${kind.id}`} aria-hidden="true">
                          <Icon size={21} />
                        </span>
                        <span>
                          <strong>{kind.label}</strong>
                          <small>{kind.description}</small>
                        </span>
                        <CaretRight size={17} aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
              ) : formKind === "workout" ? (
                <WorkoutLogForm
                  date={selectedDate}
                  timezone={timezone}
                  defaultTime={defaultTime}
                  cycle={cycle}
                  nextPhase={nextPhase}
                  onDirtyChange={(value) => {
                    dirty.current = value;
                  }}
                  onSaved={handleSaved}
                />
              ) : formKind === "body" ? (
                <BodyLogForm
                  date={selectedDate}
                  timezone={timezone}
                  defaultTime={defaultTime}
                  onDirtyChange={(value) => {
                    dirty.current = value;
                  }}
                  onSaved={handleSaved}
                />
              ) : formKind === "recovery" ? (
                <RecoveryLogForm
                  date={selectedDate}
                  timezone={timezone}
                  onDirtyChange={(value) => {
                    dirty.current = value;
                  }}
                  onSaved={handleSaved}
                />
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
