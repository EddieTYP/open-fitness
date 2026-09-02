"use client";

import {
  DotsThree,
  Moon,
  Pause,
  Play,
  X,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/components/i18n/I18nProvider";
import { clientUuid } from "@/lib/client-id";
import type { DashboardTrainingSchedule } from "@/lib/fitness";
import { addIsoDateDays } from "@/lib/training-schedule";

type TrainingScheduleControlsProps = {
  schedule: DashboardTrainingSchedule;
  onChanged: () => Promise<void>;
  variant?: "menu" | "resume";
};

async function responseJson(response: Response, fallback: string) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(fallback);
  }
  return result;
}

function ScheduleError({
  message,
  reload,
}: {
  message: string;
  reload: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="training-schedule-error-status">
      <p className="training-schedule-error" role="alert">
        {message}
      </p>
      {reload ? (
        <button
          type="button"
          className="secondary-button"
          onClick={() => window.location.reload()}
        >
          {t("fitness.schedule.reload")}
        </button>
      ) : null}
    </div>
  );
}

export function TrainingScheduleControls({
  schedule,
  onChanged,
  variant = "menu",
}: TrainingScheduleControlsProps) {
  const { t } = useI18n();
  const tomorrow = addIsoDateDays(schedule.planningDate, 1);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [manualResume, setManualResume] = useState(false);
  const [resumeOn, setResumeOn] = useState(tomorrow);
  const [busy, setBusy] = useState<"rest" | "pause" | "resume" | null>(null);
  const [committed, setCommitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const busyRef = useRef(busy);
  const committedRef = useRef(committed);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    committedRef.current = committed;
  }, [committed]);

  useEffect(() => {
    if (!menuOpen) return;
    function closeOutside(event: PointerEvent) {
      if (committedRef.current) return;
      const target = event.target as Node;
      const menu = document.getElementById("training-schedule-menu");
      if (!triggerRef.current?.contains(target) && !menu?.contains(target)) {
        setMenuOpen(false);
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || committedRef.current) return;
      setMenuOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!sheetOpen) return;
    const focusTarget =
      triggerRef.current ?? (document.activeElement as HTMLElement | null);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const timer = window.setTimeout(() => headingRef.current?.focus(), 0);

    function handleKeys(event: KeyboardEvent) {
      if (
        event.key === "Escape" &&
        busyRef.current === null &&
        !committedRef.current
      ) {
        event.preventDefault();
        setSheetOpen(false);
        setError(null);
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [
        ...dialogRef.current.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex='-1'])",
        ),
      ];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeys);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", handleKeys);
      document.body.style.overflow = previousOverflow;
      focusTarget?.focus();
    };
  }, [sheetOpen]);

  async function updateSchedule(
    body:
      | {
          action: "pause";
          effectiveDate: string;
          resumeOn: string | null;
          reason: string | null;
        }
      | {
          action: "resume";
          effectiveDate: string;
          reason: string;
        },
    pending: "rest" | "pause" | "resume",
  ) {
    setBusy(pending);
    setCommitted(false);
    setError(null);
    let saved = false;
    try {
      const response = await fetch("/api/fitness/training-schedule", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": clientUuid(),
        },
        body: JSON.stringify(body),
      });
      await responseJson(response, t("fitness.schedule.failed"));
      saved = true;
      setCommitted(true);
      await onChanged();
      setMenuOpen(false);
      setSheetOpen(false);
    } catch {
      setError(
        saved
          ? t("fitness.schedule.savedNoRefresh")
          : t("fitness.schedule.failed"),
      );
    } finally {
      setBusy(null);
    }
  }

  if (variant === "resume") {
    return (
      <div className="training-resume-action" aria-busy={busy === "resume"}>
        <button
          type="button"
          className="primary-button"
          disabled={busy !== null || committed}
          onClick={() =>
            void updateSchedule(
              {
                action: "resume",
                effectiveDate: schedule.planningDate,
                reason: t("fitness.schedule.manualResumeReason"),
              },
              "resume",
            )
          }
        >
          <Play size={17} weight="fill" aria-hidden="true" />
          {busy === "resume"
            ? t("fitness.schedule.resuming")
            : t("fitness.schedule.resume")}
        </button>
        {error ? <ScheduleError message={error} reload={committed} /> : null}
      </div>
    );
  }

  if (schedule.status === "paused") return null;

  const restLabel =
    schedule.nextPhase?.category === "recovery"
      ? t("fitness.pause.extendRecovery")
      : t("fitness.pause.restToday");

  return (
    <>
      <div className="training-schedule-menu-wrap">
        <button
          ref={triggerRef}
          type="button"
          className="training-schedule-menu-trigger"
          aria-label={t("fitness.schedule.options")}
          aria-expanded={menuOpen}
          aria-controls="training-schedule-menu"
          onClick={() => {
            setError(null);
            setMenuOpen((current) => !current);
          }}
        >
          <DotsThree size={22} weight="bold" aria-hidden="true" />
        </button>
        {menuOpen ? (
          <div
            className="training-schedule-menu"
            id="training-schedule-menu"
            aria-busy={busy !== null}
          >
            <button
              type="button"
              disabled={busy !== null || committed}
              onClick={() =>
                void updateSchedule(
                  {
                    action: "pause",
                    effectiveDate: schedule.planningDate,
                    resumeOn: tomorrow,
                    reason: restLabel,
                  },
                  "rest",
                )
              }
            >
              <Moon size={16} aria-hidden="true" />
              {busy === "rest" ? t("fitness.schedule.updating") : restLabel}
            </button>
            <button
              type="button"
              disabled={busy !== null || committed}
              onClick={() => {
                setMenuOpen(false);
                setResumeOn(tomorrow);
                setManualResume(false);
                setError(null);
                setSheetOpen(true);
              }}
            >
              <Pause size={16} weight="fill" aria-hidden="true" />
              {t("fitness.schedule.pausePlan")}
            </button>
            {error ? <ScheduleError message={error} reload={committed} /> : null}
          </div>
        ) : null}
      </div>

      {sheetOpen ? (
        <div
          className="training-schedule-backdrop"
          onPointerDown={(event) => {
            if (
              event.target === event.currentTarget &&
              busy === null &&
              !committed
            ) {
              setSheetOpen(false);
              setError(null);
            }
          }}
        >
          <section
            ref={dialogRef}
            className="training-schedule-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="training-pause-title"
            aria-describedby="training-pause-description"
            aria-busy={busy === "pause"}
          >
            <header>
              <span aria-hidden="true" />
              <h2 id="training-pause-title" ref={headingRef} tabIndex={-1}>
                {t("fitness.schedule.pausePlan")}
              </h2>
              <button
                type="button"
                aria-label={t("common.close")}
                disabled={busy !== null || committed}
                onClick={() => {
                  setSheetOpen(false);
                  setError(null);
                }}
              >
                <X size={20} aria-hidden="true" />
              </button>
            </header>
            <div className="training-schedule-sheet-body">
              <label className="training-resume-date" htmlFor="training-resume-on">
                <span>{t("fitness.schedule.resumeDate")}</span>
                <input
                  id="training-resume-on"
                  type="date"
                  min={tomorrow}
                  value={resumeOn}
                  disabled={manualResume || busy !== null || committed}
                  required={!manualResume}
                  onChange={(event) => setResumeOn(event.target.value)}
                />
              </label>
              <label className="training-manual-resume">
                <input
                  type="checkbox"
                  checked={manualResume}
                  disabled={busy !== null || committed}
                  onChange={(event) => setManualResume(event.target.checked)}
                />
                <span>{t("fitness.schedule.manualResume")}</span>
              </label>
              <p id="training-pause-description">
                {t("fitness.schedule.pauseDescription")}
              </p>
              {error ? <ScheduleError message={error} reload={committed} /> : null}
              <div className="training-schedule-sheet-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy !== null || committed}
                  onClick={() => {
                    setSheetOpen(false);
                    setError(null);
                  }}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={
                    busy !== null ||
                    committed ||
                    (!manualResume && resumeOn < tomorrow)
                  }
                  onClick={() =>
                    void updateSchedule(
                      {
                        action: "pause",
                        effectiveDate: schedule.planningDate,
                        resumeOn: manualResume ? null : resumeOn,
                        reason: null,
                      },
                      "pause",
                    )
                  }
                >
                  {busy === "pause"
                    ? t("fitness.schedule.pausing")
                    : t("fitness.schedule.pause")}
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
