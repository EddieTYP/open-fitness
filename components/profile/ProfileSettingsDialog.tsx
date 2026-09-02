"use client";

import {
  ArrowDown,
  ArrowUp,
  Check,
  Plus,
  Trash,
  X,
} from "@phosphor-icons/react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { persistDeviceLocale } from "@/components/i18n/LocaleSelect";
import { useI18n } from "@/components/i18n/I18nProvider";
import { clientUuid } from "@/lib/client-id";
import type { Translator } from "@/lib/i18n/catalog";
import {
  APP_LOCALES,
  APP_LOCALE_LABELS,
  isAppLocale,
  type AppLocale,
} from "@/lib/i18n/locales";
import {
  CALORIE_TARGET_MAX_KCAL,
  CALORIE_TARGET_MIN_KCAL,
  PROTEIN_TARGET_MAX_G,
} from "@/lib/nutrition-targets";
import { isDateOnly } from "@/lib/record-utils";
import { isSupportedTimeZone } from "@/lib/timezone.mjs";

import styles from "./ProfileSettingsDialog.module.css";

const PROJECT_SOURCE_REF = "v0.1.0";
const PROJECT_SOURCE_URL =
  `https://github.com/EddieTYP/open-fitness/tree/${PROJECT_SOURCE_REF}`;
const PROJECT_LICENSE_URL =
  `https://github.com/EddieTYP/open-fitness/blob/${PROJECT_SOURCE_REF}/LICENSE`;

export type ProfileGoalType =
  | "fat_loss"
  | "muscle_gain"
  | "strength"
  | "endurance"
  | "maintenance"
  | "general";

export type ProfileCyclePhase = {
  id: string;
  label: string;
  kind: "training" | "recovery";
  routine?: ProfileRoutineSlot[];
};

export type ProfileRoutineSlot = {
  id: string;
  label: string;
  preferredExercise: string;
  alternatives: string[];
  targetSets?: number;
  targetReps?: string;
  targetEffort?: string;
  loadIncrementKg?: number;
};

export type FitnessProfileSettings = {
  displayName: string | null;
  primaryGoal: string;
  goalType: ProfileGoalType;
  preferredLocale: AppLocale;
  timezone: string;
  heightCm: number | null;
  trainingCycleConfig: {
    version: 1 | 2;
    phases: ProfileCyclePhase[];
  };
  strengthProgressExercise: string | null;
  nutritionTarget: {
    effectiveFrom: string;
    calorieTargetKcal: number | null;
    proteinTargetG: number;
  } | null;
  currentTrainingBlock: {
    blockId: string;
    goalType: ProfileGoalType;
    primaryGoal: string;
    startsOn: string;
    changeReason: string;
    createdAt: string;
  } | null;
  setupCompleted: boolean;
  updatedAt: string;
};

type ProfileDraft = {
  displayName: string;
  preferredLocale: AppLocale;
  timezone: string;
  goalType: ProfileGoalType;
  primaryGoal: string;
  heightCm: string;
  strengthProgressExercise: string;
  calorieTargetKcal: string;
  proteinTargetG: string;
  nutritionTargetEffectiveFrom: string;
  phases: ProfileCyclePhase[];
};

type ProfileSettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (profile: FitnessProfileSettings) => void;
};

type ProfileResult = {
  effectiveDate?: string;
  profile?: FitnessProfileSettings;
};

class ProfileRequestError extends Error {
  constructor(readonly kind: "conflict" | "generic") {
    super(kind);
  }
}

const MAX_PHASES = 12;
const FOCUSABLE_SELECTOR = [
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

const goalOptions: Array<{ value: ProfileGoalType; messageKey: string }> = [
  { value: "general", messageKey: "profile.goal.general" },
  { value: "fat_loss", messageKey: "profile.goal.fatLoss" },
  { value: "muscle_gain", messageKey: "profile.goal.muscleGain" },
  { value: "strength", messageKey: "profile.goal.strength" },
  { value: "endurance", messageKey: "profile.goal.endurance" },
  { value: "maintenance", messageKey: "profile.goal.maintenance" },
];

const commonTimezones = [
  "Asia/Hong_Kong",
  "Asia/Taipei",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Australia/Sydney",
  "Europe/London",
  "America/New_York",
  "America/Los_Angeles",
  "UTC",
];

function readProfileResult(response: Response): Promise<ProfileResult> {
  return response
    .json()
    .catch(() => ({}))
    .then((result: ProfileResult) => {
      if (response.ok) return result;
      throw new ProfileRequestError(
        response.status === 409 ? "conflict" : "generic",
      );
    });
}

function requestErrorMessage(
  error: unknown,
  t: Translator,
  fallbackKey: "profile.error.load" | "profile.error.save",
) {
  return error instanceof ProfileRequestError && error.kind === "conflict"
    ? t("profile.error.conflict")
    : t(fallbackKey);
}

function draftFromProfile(
  profile: FitnessProfileSettings,
  setupLocale: AppLocale,
  suggestedEffectiveDate = "",
): ProfileDraft {
  return {
    displayName: profile.displayName ?? "",
    preferredLocale: profile.setupCompleted
      ? profile.preferredLocale
      : setupLocale,
    timezone: profile.timezone,
    goalType: profile.goalType,
    primaryGoal: profile.primaryGoal,
    heightCm: profile.heightCm === null ? "" : String(profile.heightCm),
    strengthProgressExercise: profile.strengthProgressExercise ?? "",
    calorieTargetKcal:
      profile.nutritionTarget?.calorieTargetKcal === null ||
      profile.nutritionTarget?.calorieTargetKcal === undefined
        ? ""
        : String(profile.nutritionTarget.calorieTargetKcal),
    proteinTargetG:
      profile.nutritionTarget?.proteinTargetG === undefined
        ? ""
        : String(profile.nutritionTarget.proteinTargetG),
    nutritionTargetEffectiveFrom:
      profile.nutritionTarget?.effectiveFrom ??
      (profile.setupCompleted ? "" : suggestedEffectiveDate),
    phases: profile.trainingCycleConfig.phases.map((phase) => ({
      ...phase,
      routine: phase.routine?.map((slot) => ({
        ...slot,
        alternatives: [...slot.alternatives],
      })),
    })),
  };
}

function serialiseDraft(draft: ProfileDraft) {
  return JSON.stringify(draft);
}

function nutritionTargetChanged(
  draft: ProfileDraft,
  stored: FitnessProfileSettings["nutritionTarget"],
) {
  return (
    draft.calorieTargetKcal !==
      (stored?.calorieTargetKcal === null ||
      stored?.calorieTargetKcal === undefined
        ? ""
        : String(stored.calorieTargetKcal)) ||
    draft.proteinTargetG !==
      (stored?.proteinTargetG === undefined
        ? ""
        : String(stored.proteinTargetG)) ||
    draft.nutritionTargetEffectiveFrom !== (stored?.effectiveFrom ?? "")
  );
}

function phaseIdentity(label: string) {
  return label
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_/·•|:()（）\-]+/g, " ")
    .trim();
}

function validateDraft(
  draft: ProfileDraft,
  t: Translator,
  requireNutritionTarget = false,
): string | null {
  const displayName = draft.displayName.trim();
  if (!displayName) return t("profile.validation.displayNameRequired");
  if (displayName.length > 80) {
    return t("profile.validation.displayNameLength");
  }
  const primaryGoal = draft.primaryGoal.trim();
  if (!primaryGoal) return t("profile.validation.goalRequired");
  if (primaryGoal.length > 500) return t("profile.validation.goalLength");
  if (!isSupportedTimeZone(draft.timezone)) {
    return t("profile.validation.timezone");
  }

  if (draft.heightCm !== "") {
    const heightCm = Number(draft.heightCm);
    if (!Number.isFinite(heightCm) || heightCm < 80 || heightCm > 250) {
      return t("profile.validation.height");
    }
  }

  if (draft.strengthProgressExercise.trim().length > 120) {
    return t("profile.validation.strengthExerciseLength");
  }
  if (requireNutritionTarget) {
    if (
      !draft.calorieTargetKcal.trim() ||
      !draft.proteinTargetG.trim() ||
      !draft.nutritionTargetEffectiveFrom.trim()
    ) {
      return t("profile.validation.nutritionTargetRequired");
    }
    const calorieTargetKcal = Number(draft.calorieTargetKcal);
    if (
      !Number.isInteger(calorieTargetKcal) ||
      calorieTargetKcal < CALORIE_TARGET_MIN_KCAL ||
      calorieTargetKcal > CALORIE_TARGET_MAX_KCAL
    ) {
      return t("profile.validation.calorieTarget");
    }
    const proteinTargetG = Number(draft.proteinTargetG);
    if (
      !Number.isFinite(proteinTargetG) ||
      proteinTargetG <= 0 ||
      proteinTargetG > PROTEIN_TARGET_MAX_G
    ) {
      return t("profile.validation.proteinTarget");
    }
    if (!isDateOnly(draft.nutritionTargetEffectiveFrom)) {
      return t("profile.validation.nutritionTargetDate");
    }
  }
  if (draft.phases.length < 1 || draft.phases.length > MAX_PHASES) {
    return t("profile.validation.phaseCount", { max: MAX_PHASES });
  }
  if (!draft.phases.some((phase) => phase.kind === "training")) {
    return t("profile.validation.trainingPhaseRequired");
  }

  const identities = new Set<string>();
  for (const phase of draft.phases) {
    const label = phase.label.trim();
    if (!label) return t("profile.validation.phaseNameRequired");
    if (label.length > 80) return t("profile.validation.phaseNameLength");
    const identity = phaseIdentity(label);
    if (identities.has(identity)) {
      return t("profile.validation.phaseNameDuplicate");
    }
    identities.add(identity);
    const slotIds = new Set<string>();
    for (const slot of phase.routine ?? []) {
      if (phase.kind !== "training") {
        return t("profile.validation.recoveryRoutine");
      }
      if (!slot.label.trim()) {
        return t("profile.validation.routinePurposeRequired");
      }
      if (!slot.preferredExercise.trim()) {
        return t("profile.validation.preferredExerciseRequired");
      }
      if (slotIds.has(slot.id)) {
        return t("profile.validation.routineDuplicate");
      }
      slotIds.add(slot.id);
      const exercises = [slot.preferredExercise, ...slot.alternatives]
        .map(phaseIdentity)
        .filter(Boolean);
      if (new Set(exercises).size !== exercises.length) {
        return t("profile.validation.exerciseDuplicate");
      }
      if (slot.alternatives.length > 8) {
        return t("profile.validation.alternativesLength", { max: 8 });
      }
      if (
        slot.loadIncrementKg !== undefined &&
        (!Number.isFinite(slot.loadIncrementKg) ||
          slot.loadIncrementKg <= 0 ||
          slot.loadIncrementKg > 100)
      ) {
        return t("profile.validation.loadIncrement");
      }
    }
  }
  return null;
}

function newPhaseId() {
  return `phase-${clientUuid()}`;
}

function newRoutineId() {
  return `slot-${clientUuid()}`;
}

export function ProfileSettingsDialog({
  open,
  onOpenChange,
  onSaved,
}: ProfileSettingsDialogProps) {
  const { locale, t, formatDate } = useI18n();
  const [profile, setProfile] = useState<FitnessProfileSettings | null>(null);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [savedDraft, setSavedDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">(
    "idle",
  );
  const [reloadKey, setReloadKey] = useState(0);
  const dialogRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const savedTimerRef = useRef<number | null>(null);

  const dirty =
    Boolean(profile && draft) &&
    (serialiseDraft(draft!) !== savedDraft || !profile!.setupCompleted);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    savingRef.current = saveState === "saving";
  }, [saveState]);

  const requestDismiss = useCallback(() => {
    if (savingRef.current) return;
    if (dirtyRef.current && !window.confirm(t("profile.confirm.discard"))) {
      return;
    }
    onOpenChange(false);
  }, [onOpenChange, t]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();

    void (async () => {
      await Promise.resolve();
      if (controller.signal.aborted) return;
      setLoading(true);
      setLoadError(null);
      setSaveError(null);
      setSaveState("idle");
      setProfile(null);
      setDraft(null);
      setSavedDraft("");
      try {
        const response = await fetch("/api/fitness/profile", {
          cache: "no-store",
          signal: controller.signal,
        });
        const result = await readProfileResult(response);
        if (!result.profile) throw new ProfileRequestError("generic");
        const nextDraft = draftFromProfile(
          result.profile,
          locale,
          result.effectiveDate,
        );
        setProfile(result.profile);
        setDraft(nextDraft);
        setSavedDraft(serialiseDraft(nextDraft));
      } catch (error: unknown) {
        if (controller.signal.aborted) return;
        setLoadError(requestErrorMessage(error, t, "profile.error.load"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [locale, open, reloadKey, t]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusTimer = window.setTimeout(() => headingRef.current?.focus(), 0);
    function handleDialogKeys(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        requestDismiss();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [
        ...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
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

    document.addEventListener("keydown", handleDialogKeys);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleDialogKeys);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [open, requestDismiss]);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current !== null) {
        window.clearTimeout(savedTimerRef.current);
      }
    };
  }, []);

  function updatePhase(index: number, patch: Partial<ProfileCyclePhase>) {
    setSaveError(null);
    setSaveState("idle");
    setDraft((current) =>
      current
        ? {
            ...current,
            phases: current.phases.map((phase, phaseIndex) =>
              phaseIndex === index ? { ...phase, ...patch } : phase,
            ),
          }
        : current,
    );
  }

  function updateRoutineSlot(
    phaseIndex: number,
    slotIndex: number,
    patch: Partial<ProfileRoutineSlot>,
  ) {
    setSaveError(null);
    setSaveState("idle");
    setDraft((current) =>
      current
        ? {
            ...current,
            phases: current.phases.map((phase, currentPhaseIndex) =>
              currentPhaseIndex !== phaseIndex
                ? phase
                : {
                    ...phase,
                    routine: (phase.routine ?? []).map((slot, currentSlotIndex) =>
                      currentSlotIndex === slotIndex
                        ? { ...slot, ...patch }
                        : slot,
                    ),
                  },
            ),
          }
        : current,
    );
  }

  function addRoutineSlot(phaseIndex: number) {
    setSaveError(null);
    setSaveState("idle");
    setDraft((current) =>
      current
        ? {
            ...current,
            phases: current.phases.map((phase, currentPhaseIndex) =>
              currentPhaseIndex !== phaseIndex ||
              (phase.routine?.length ?? 0) >= 20
                ? phase
                : {
                    ...phase,
                    routine: [
                      ...(phase.routine ?? []),
                      {
                        id: newRoutineId(),
                        label: "",
                        preferredExercise: "",
                        alternatives: [],
                      },
                    ],
                  },
            ),
          }
        : current,
    );
  }

  function removeRoutineSlot(phaseIndex: number, slotIndex: number) {
    setSaveError(null);
    setSaveState("idle");
    setDraft((current) =>
      current
        ? {
            ...current,
            phases: current.phases.map((phase, currentPhaseIndex) =>
              currentPhaseIndex !== phaseIndex
                ? phase
                : {
                    ...phase,
                    routine: (phase.routine ?? []).filter(
                      (_slot, currentSlotIndex) => currentSlotIndex !== slotIndex,
                    ),
                  },
            ),
          }
        : current,
    );
  }

  function changePhaseKind(
    index: number,
    kind: ProfileCyclePhase["kind"],
  ) {
    setSaveError(null);
    setSaveState("idle");
    setDraft((current) =>
      current
        ? {
            ...current,
            phases: current.phases.map((phase, phaseIndex) =>
              phaseIndex === index && phase.kind !== kind
                ? {
                    ...phase,
                    id: newPhaseId(),
                    kind,
                    routine: kind === "recovery" ? [] : phase.routine,
                  }
                : phase,
            ),
          }
        : current,
    );
  }

  function movePhase(index: number, offset: -1 | 1) {
    setSaveError(null);
    setSaveState("idle");
    setDraft((current) => {
      if (!current) return current;
      const destination = index + offset;
      if (destination < 0 || destination >= current.phases.length) return current;
      const phases = [...current.phases];
      [phases[index], phases[destination]] = [
        phases[destination],
        phases[index],
      ];
      return { ...current, phases };
    });
  }

  function removePhase(index: number) {
    setSaveError(null);
    setSaveState("idle");
    setDraft((current) =>
      current
        ? {
            ...current,
            phases: current.phases.filter(
              (_phase, phaseIndex) => phaseIndex !== index,
            ),
          }
        : current,
    );
  }

  function addPhase() {
    setSaveError(null);
    setSaveState("idle");
    setDraft((current) => {
      if (!current || current.phases.length >= MAX_PHASES) return current;
      return {
        ...current,
        phases: [
          ...current.phases,
          { id: newPhaseId(), label: "", kind: "training", routine: [] },
        ],
      };
    });
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile || !draft || saveState === "saving") return;
    const includeNutritionTarget =
      !profile.setupCompleted ||
      nutritionTargetChanged(draft, profile.nutritionTarget);
    const validationError = validateDraft(draft, t, includeNutritionTarget);
    if (validationError) {
      setSaveError(validationError);
      return;
    }
    const localeChanged = draft.preferredLocale !== profile.preferredLocale;

    setSaveError(null);
    setSaveState("saving");
    if (savedTimerRef.current !== null) {
      window.clearTimeout(savedTimerRef.current);
      savedTimerRef.current = null;
    }
    try {
      const response = await fetch("/api/fitness/profile", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": clientUuid(),
        },
        body: JSON.stringify({
          expectedUpdatedAt: profile.updatedAt,
          displayName: draft.displayName.trim(),
          preferredLocale: draft.preferredLocale,
          timezone: draft.timezone.trim(),
          goalType: draft.goalType,
          primaryGoal: draft.primaryGoal.trim(),
          heightCm: draft.heightCm === "" ? null : Number(draft.heightCm),
          strengthProgressExercise:
            draft.strengthProgressExercise.trim() || null,
          ...(includeNutritionTarget
            ? {
                nutritionTarget: {
                  effectiveFrom: draft.nutritionTargetEffectiveFrom,
                  calorieTargetKcal: Number(draft.calorieTargetKcal),
                  proteinTargetG: Number(draft.proteinTargetG),
                },
              }
            : {}),
          trainingCycleConfig: {
            version: 2,
            phases: draft.phases.map((phase) => ({
              ...phase,
              label: phase.label.trim(),
              routine:
                phase.kind === "training"
                  ? (phase.routine ?? []).map((slot) => ({
                      ...slot,
                      label: slot.label.trim(),
                      preferredExercise: slot.preferredExercise.trim(),
                      alternatives: slot.alternatives
                        .map((alternative) => alternative.trim())
                        .filter(Boolean),
                      ...(slot.targetReps?.trim()
                        ? { targetReps: slot.targetReps.trim() }
                        : { targetReps: undefined }),
                      ...(slot.targetEffort?.trim()
                        ? { targetEffort: slot.targetEffort.trim() }
                        : { targetEffort: undefined }),
                    }))
                  : [],
            })),
          },
          setupCompleted: true,
        }),
      });
      const result = await readProfileResult(response);
      if (!result.profile) throw new ProfileRequestError("generic");
      const nextDraft = draftFromProfile(result.profile, locale);
      setProfile(result.profile);
      setDraft(nextDraft);
      setSavedDraft(serialiseDraft(nextDraft));
      setSaveState("saved");
      onSaved?.(result.profile);
      if (localeChanged) {
        persistDeviceLocale(result.profile.preferredLocale);
        window.location.reload();
        return;
      }
      savedTimerRef.current = window.setTimeout(() => {
        setSaveState("idle");
        savedTimerRef.current = null;
      }, 1800);
    } catch (error: unknown) {
      setSaveState("idle");
      setSaveError(requestErrorMessage(error, t, "profile.error.save"));
    }
  }

  if (!open) return null;

  const trainingPhaseCount =
    draft?.phases.filter((phase) => phase.kind === "training").length ?? 0;
  const nutritionTargetRequired = Boolean(
    profile &&
      draft &&
      (!profile.setupCompleted ||
        nutritionTargetChanged(draft, profile.nutritionTarget)),
  );

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) requestDismiss();
      }}
    >
      <section
        ref={dialogRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-settings-title"
        aria-describedby="profile-settings-description"
        aria-busy={loading || saveState === "saving"}
      >
        <header className={styles.header}>
          <div>
            <h2
              id="profile-settings-title"
              ref={headingRef}
              tabIndex={-1}
            >
              {t("profile.title")}
            </h2>
            <span id="profile-settings-description">
              {t("profile.description")}
            </span>
          </div>
          <button
            type="button"
            aria-label={t("profile.closeLabel")}
            onClick={requestDismiss}
            disabled={saveState === "saving"}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </header>

        {loading ? (
          <div className={styles.state} role="status" aria-live="polite">
            {t("profile.loading")}
          </div>
        ) : loadError || !draft ? (
          <div className={styles.state}>
            <div className={styles.error} role="alert">
              {loadError || t("profile.error.load")}
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setReloadKey((value) => value + 1)}
            >
              {t("profile.reload")}
            </button>
          </div>
        ) : (
          <form className={styles.form} onSubmit={saveProfile} noValidate>
            <div className={styles.body}>
              <section
                className={styles.section}
                aria-labelledby="profile-basic-heading"
              >
                <div className={styles.sectionHeader}>
                  <h3 id="profile-basic-heading">
                    {t("profile.section.basic")}
                  </h3>
                </div>
                <div className={styles.fieldGrid}>
                  <label className="field-block">
                    <span>{t("profile.field.displayName")}</span>
                    <input
                      value={draft.displayName}
                      maxLength={80}
                      autoComplete="name"
                      onChange={(event) => {
                        setSaveError(null);
                        setSaveState("idle");
                        setDraft({ ...draft, displayName: event.target.value });
                      }}
                      required
                    />
                  </label>
                  <label className="field-block">
                    <span>{t("profile.field.goalType")}</span>
                    <select
                      value={draft.goalType}
                      onChange={(event) => {
                        setSaveError(null);
                        setSaveState("idle");
                        setDraft({
                          ...draft,
                          goalType: event.target.value as ProfileGoalType,
                        });
                      }}
                    >
                      {goalOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {t(option.messageKey)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={`field-block ${styles.goalDetailField}`}>
                    <span>{t("profile.field.goalDetails")}</span>
                    <textarea
                      value={draft.primaryGoal}
                      maxLength={500}
                      rows={3}
                      placeholder={t("profile.placeholder.goalDetails")}
                      onChange={(event) => {
                        setSaveError(null);
                        setSaveState("idle");
                        setDraft({
                          ...draft,
                          primaryGoal: event.target.value,
                        });
                      }}
                      required
                    />
                  </label>
                  <label className="field-block">
                    <span>{t("profile.field.height")}</span>
                    <input
                      type="number"
                      min="80"
                      max="250"
                      step="0.1"
                      inputMode="decimal"
                      value={draft.heightCm}
                      onChange={(event) => {
                        setSaveError(null);
                        setSaveState("idle");
                        setDraft({ ...draft, heightCm: event.target.value });
                      }}
                    />
                  </label>
                  <label className="field-block">
                    <span>{t("profile.field.strengthExercise")}</span>
                    <input
                      value={draft.strengthProgressExercise}
                      maxLength={120}
                      placeholder={t("profile.placeholder.strengthExercise")}
                      onChange={(event) => {
                        setSaveError(null);
                        setSaveState("idle");
                        setDraft({
                          ...draft,
                          strengthProgressExercise: event.target.value,
                        });
                      }}
                    />
                  </label>
                  <label className="field-block">
                    <span>{t("profile.field.locale")}</span>
                    <select
                      value={draft.preferredLocale}
                      onChange={(event) => {
                        const preferredLocale = event.target.value;
                        if (!isAppLocale(preferredLocale)) return;
                        setSaveError(null);
                        setSaveState("idle");
                        setDraft({ ...draft, preferredLocale });
                      }}
                    >
                      {APP_LOCALES.map((locale) => (
                        <option key={locale} value={locale}>
                          {APP_LOCALE_LABELS[locale]}
                        </option>
                      ))}
                    </select>
                    <small>{t("profile.localeHelp")}</small>
                  </label>
                </div>
                <div className={`field-block ${styles.timezoneField}`}>
                  <label htmlFor="profile-timezone">
                    {t("profile.field.timezone")}
                  </label>
                  <div className={styles.timezoneControl}>
                    <input
                      id="profile-timezone"
                      list="profile-timezones"
                      value={draft.timezone}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(event) => {
                        setSaveError(null);
                        setSaveState("idle");
                        setDraft({ ...draft, timezone: event.target.value });
                      }}
                      required
                    />
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
                        if (!detected) return;
                        setSaveError(null);
                        setSaveState("idle");
                        setDraft({ ...draft, timezone: detected });
                      }}
                    >
                      {t("profile.timezoneUseDevice")}
                    </button>
                  </div>
                  <datalist id="profile-timezones">
                    {commonTimezones.map((timezone) => (
                      <option key={timezone} value={timezone} />
                    ))}
                  </datalist>
                  <small>{t("profile.timezoneHelp")}</small>
                </div>
              </section>

              <section
                className={styles.section}
                aria-labelledby="nutrition-target-heading"
              >
                <div className={styles.sectionHeader}>
                  <div>
                    <h3 id="nutrition-target-heading">
                      {t("profile.section.nutritionTarget")}
                    </h3>
                    <p>{t("profile.nutritionTargetHelp")}</p>
                  </div>
                </div>
                <div
                  className={`${styles.fieldGrid} ${styles.nutritionTargetGrid}`}
                >
                  <label className="field-block">
                    <span>{t("profile.field.calorieTarget")}</span>
                    <input
                      type="number"
                      min={CALORIE_TARGET_MIN_KCAL}
                      max={CALORIE_TARGET_MAX_KCAL}
                      step="1"
                      inputMode="numeric"
                      value={draft.calorieTargetKcal}
                      onChange={(event) => {
                        setSaveError(null);
                        setSaveState("idle");
                        setDraft({
                          ...draft,
                          calorieTargetKcal: event.target.value,
                        });
                      }}
                      required={nutritionTargetRequired}
                    />
                  </label>
                  <label className="field-block">
                    <span>{t("profile.field.proteinTarget")}</span>
                    <input
                      type="number"
                      min="0.1"
                      max={PROTEIN_TARGET_MAX_G}
                      step="0.1"
                      inputMode="decimal"
                      value={draft.proteinTargetG}
                      onChange={(event) => {
                        setSaveError(null);
                        setSaveState("idle");
                        setDraft({
                          ...draft,
                          proteinTargetG: event.target.value,
                        });
                      }}
                      required={nutritionTargetRequired}
                    />
                  </label>
                  <label className="field-block">
                    <span>{t("profile.field.nutritionTargetDate")}</span>
                    <input
                      type="date"
                      value={draft.nutritionTargetEffectiveFrom}
                      onChange={(event) => {
                        setSaveError(null);
                        setSaveState("idle");
                        setDraft({
                          ...draft,
                          nutritionTargetEffectiveFrom: event.target.value,
                        });
                      }}
                      required={nutritionTargetRequired}
                    />
                  </label>
                </div>
              </section>

              <section
                className={styles.section}
                aria-labelledby="training-cycle-heading"
              >
                <div className={styles.sectionHeader}>
                  <div>
                    <h3 id="training-cycle-heading">
                      {t("profile.section.cycle")}
                    </h3>
                    <p>{t("profile.cycleHelp")}</p>
                  </div>
                  <span>
                    {draft.phases.length} / {MAX_PHASES}
                  </span>
                </div>

                {profile?.currentTrainingBlock ? (
                  <div className={styles.trainingBlockSummary}>
                    <span>{t("profile.block.current")}</span>
                    <strong>
                      {t(
                        goalOptions.find(
                          (option) =>
                            option.value === profile.currentTrainingBlock?.goalType,
                        )?.messageKey ?? "profile.goal.general",
                      )}
                    </strong>
                    <small>
                      {t("profile.block.started", {
                        date: formatDate(profile.currentTrainingBlock.startsOn, {
                          dateStyle: "medium",
                        }),
                      })}
                    </small>
                  </div>
                ) : null}

                <div className={styles.phaseList}>
                  {draft.phases.map((phase, index) => {
                    const isOnlyTrainingPhase =
                      phase.kind === "training" && trainingPhaseCount === 1;
                    const cannotRemove =
                      draft.phases.length === 1 || isOnlyTrainingPhase;
                    const phaseName =
                      phase.label.trim() ||
                      t("profile.phase.fallback", { number: index + 1 });
                    return (
                      <div className={styles.phaseRow} key={phase.id}>
                        <span
                          className={styles.phaseOrdinal}
                          aria-hidden="true"
                        >
                          {index + 1}
                        </span>
                        <label className={styles.phaseLabel}>
                          <span className="sr-only">
                            {t("profile.phase.nameA11y", { number: index + 1 })}
                          </span>
                          <input
                            value={phase.label}
                            maxLength={80}
                            placeholder={t("profile.phase.namePlaceholder")}
                            onChange={(event) =>
                              updatePhase(index, { label: event.target.value })
                            }
                            required
                          />
                        </label>
                        <label className={styles.phaseKind}>
                          <span className="sr-only">
                            {t("profile.phase.kindA11y", { name: phaseName })}
                          </span>
                          <select
                            value={phase.kind}
                            onChange={(event) =>
                              event.target.value !== "recovery" ||
                              !(phase.routine?.length ?? 0) ||
                              window.confirm(
                                t("profile.confirm.convertRecovery"),
                              )
                                ? changePhaseKind(
                                    index,
                                    event.target.value as ProfileCyclePhase["kind"],
                                  )
                                : undefined
                            }
                            aria-label={t("profile.phase.kindA11y", {
                              name: phaseName,
                            })}
                          >
                            <option value="training">
                              {t("profile.phase.training")}
                            </option>
                            <option
                              value="recovery"
                              disabled={isOnlyTrainingPhase}
                            >
                              {t("profile.phase.recovery")}
                            </option>
                          </select>
                        </label>
                        <div className={styles.phaseActions}>
                          <button
                            type="button"
                            aria-label={t("profile.phase.moveUp", {
                              name: phaseName,
                            })}
                            onClick={() => movePhase(index, -1)}
                            disabled={index === 0}
                          >
                            <ArrowUp size={17} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            aria-label={t("profile.phase.moveDown", {
                              name: phaseName,
                            })}
                            onClick={() => movePhase(index, 1)}
                            disabled={index === draft.phases.length - 1}
                          >
                            <ArrowDown size={17} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className={styles.removeButton}
                            aria-label={t("profile.phase.remove", {
                              name: phaseName,
                            })}
                            title={
                              cannotRemove
                                ? t("profile.phase.minimumTitle")
                                : undefined
                            }
                            onClick={() => removePhase(index)}
                            disabled={cannotRemove}
                          >
                            <Trash size={17} aria-hidden="true" />
                          </button>
                        </div>
                        {phase.kind === "training" ? (
                          <details className={styles.routineEditor}>
                            <summary>
                              <span>
                                {t("profile.routine.title")}
                                {(phase.routine?.length ?? 0) > 0
                                  ? ` ${t("profile.routine.count", {
                                      count: (phase.routine ?? []).length,
                                    })}`
                                  : t("profile.routine.unset")}
                              </span>
                              <small>{t("profile.routine.summary")}</small>
                            </summary>
                            <div className={styles.routineBody}>
                              {(phase.routine ?? []).map((slot, slotIndex) => (
                                <div
                                  className={styles.routineSlot}
                                  key={slot.id}
                                >
                                  <div className={styles.routineSlotHeading}>
                                    <strong>
                                      {t("profile.routine.item", {
                                        number: slotIndex + 1,
                                      })}
                                    </strong>
                                    <button
                                      type="button"
                                      aria-label={t("profile.routine.remove", {
                                        number: slotIndex + 1,
                                      })}
                                      onClick={() =>
                                        removeRoutineSlot(index, slotIndex)
                                      }
                                    >
                                      <Trash size={16} aria-hidden="true" />
                                    </button>
                                  </div>
                                  <label>
                                    <span>{t("profile.routine.purpose")}</span>
                                    <input
                                      value={slot.label}
                                      maxLength={80}
                                      placeholder={t(
                                        "profile.routine.purposePlaceholder",
                                      )}
                                      onChange={(event) =>
                                        updateRoutineSlot(index, slotIndex, {
                                          label: event.target.value,
                                        })
                                      }
                                    />
                                  </label>
                                  <label>
                                    <span>
                                      {t("profile.routine.preferredExercise")}
                                    </span>
                                    <input
                                      value={slot.preferredExercise}
                                      maxLength={120}
                                      placeholder={t(
                                        "profile.routine.preferredExercisePlaceholder",
                                      )}
                                      onChange={(event) =>
                                        updateRoutineSlot(index, slotIndex, {
                                          preferredExercise: event.target.value,
                                        })
                                      }
                                    />
                                  </label>
                                  <label className={styles.routineAlternatives}>
                                    <span>
                                      {t("profile.routine.alternatives")}
                                    </span>
                                    <textarea
                                      value={slot.alternatives.join("\n")}
                                      placeholder={t(
                                        "profile.routine.alternativesPlaceholder",
                                      )}
                                      onChange={(event) =>
                                        updateRoutineSlot(index, slotIndex, {
                                          alternatives: event.target.value
                                            .split("\n"),
                                        })
                                      }
                                    />
                                  </label>
                                  <div className={styles.routineTargets}>
                                    <label>
                                      <span>{t("profile.routine.sets")}</span>
                                      <input
                                        type="number"
                                        min={1}
                                        max={20}
                                        value={slot.targetSets ?? ""}
                                        placeholder={t("profile.routine.auto")}
                                        onChange={(event) =>
                                          updateRoutineSlot(index, slotIndex, {
                                            targetSets: event.target.value
                                              ? Number(event.target.value)
                                              : undefined,
                                          })
                                        }
                                      />
                                    </label>
                                    <label>
                                      <span>{t("profile.routine.reps")}</span>
                                      <input
                                        value={slot.targetReps ?? ""}
                                        maxLength={40}
                                        placeholder={t(
                                          "profile.routine.repsPlaceholder",
                                        )}
                                        onChange={(event) =>
                                          updateRoutineSlot(index, slotIndex, {
                                            targetReps: event.target.value,
                                          })
                                        }
                                      />
                                    </label>
                                    <label>
                                      <span>{t("profile.routine.effort")}</span>
                                      <input
                                        value={slot.targetEffort ?? ""}
                                        maxLength={40}
                                        placeholder={t(
                                          "profile.routine.effortPlaceholder",
                                        )}
                                        onChange={(event) =>
                                          updateRoutineSlot(index, slotIndex, {
                                            targetEffort: event.target.value,
                                          })
                                        }
                                      />
                                    </label>
                                    <label>
                                      <span>{t("profile.routine.loadIncrement")}</span>
                                      <input
                                        type="number"
                                        min={0.01}
                                        max={100}
                                        step="0.01"
                                        inputMode="decimal"
                                        value={slot.loadIncrementKg ?? ""}
                                        placeholder={t("profile.routine.auto")}
                                        onChange={(event) =>
                                          updateRoutineSlot(index, slotIndex, {
                                            loadIncrementKg: event.target.value
                                              ? Number(event.target.value)
                                              : undefined,
                                          })
                                        }
                                      />
                                    </label>
                                  </div>
                                </div>
                              ))}
                              <button
                                type="button"
                                className={`secondary-button ${styles.addRoutineButton}`}
                                onClick={() => addRoutineSlot(index)}
                                disabled={(phase.routine?.length ?? 0) >= 20}
                              >
                                <Plus size={16} aria-hidden="true" />
                                {t("profile.routine.add")}
                              </button>
                            </div>
                          </details>
                        ) : null}
                      </div>
                    );
                  })}
                </div>

                <button
                  type="button"
                  className={`secondary-button ${styles.addButton}`}
                  onClick={addPhase}
                  disabled={draft.phases.length >= MAX_PHASES}
                >
                  <Plus size={17} weight="bold" aria-hidden="true" />
                  {t("profile.phase.add")}
                </button>
              </section>

              <section
                className={styles.safetyNote}
                aria-labelledby="profile-safety-heading"
              >
                <h3 id="profile-safety-heading">
                  {t("profile.safety.title")}
                </h3>
                <p>{t("profile.safety.body")}</p>
              </section>

              <p className={styles.projectMeta}>
                <a
                  href={PROJECT_SOURCE_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("profile.project.source")}
                </a>
                <span aria-hidden="true">·</span>
                <a
                  href={PROJECT_LICENSE_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("profile.project.license")}
                </a>
              </p>

              {saveError ? (
                <div className={styles.error} role="alert">
                  {saveError}
                </div>
              ) : null}
              <div className={styles.savedStatus} role="status" aria-live="polite">
                {saveState === "saved" ? (
                  <>
                    <Check size={17} weight="bold" aria-hidden="true" />
                    {t("common.saved")}
                  </>
                ) : null}
              </div>
            </div>

            <footer className={styles.footer}>
              <button
                type="button"
                className="secondary-button"
                onClick={requestDismiss}
                disabled={saveState === "saving"}
              >
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={!dirty || saveState === "saving"}
              >
                {saveState === "saving"
                  ? t("common.saving")
                  : t("profile.save")}
              </button>
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}
