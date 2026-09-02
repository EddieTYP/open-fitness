"use client";

import { useRef, useState, type FormEvent } from "react";
import { useI18n } from "@/components/i18n/I18nProvider";
import { clientUuid } from "@/lib/client-id";
import type { Translator } from "@/lib/i18n/catalog";
import type { CyclePhase } from "@/lib/training-cycle";
import { zonedDateTimeToIso } from "@/lib/timezone.mjs";

export type LogFormKind = "workout" | "body" | "recovery" | "meal";

type FormProps = {
  date: string;
  timezone: string;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (message: string) => Promise<void>;
};

function optionalText(form: FormData, name: string) {
  const value = String(form.get(name) ?? "").trim();
  return value || undefined;
}

function requiredText(form: FormData, name: string) {
  return String(form.get(name) ?? "").trim();
}

function optionalNumber(form: FormData, name: string) {
  const value = String(form.get(name) ?? "").trim();
  return value === "" ? undefined : Number(value);
}

function timestampForTimezone(date: string, time: string, timezone: string) {
  return zonedDateTimeToIso(date, time, timezone);
}

function formErrorMessage(status: number, t: Translator) {
  return t("log.form.saveFailedStatus", { status });
}

async function postJson(
  path: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
  t: Translator,
) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(payload),
  });
  await response.json().catch(() => null);
  if (!response.ok) throw new Error(formErrorMessage(response.status, t));
}

function useRecordSubmit({ onDirtyChange, onSaved }: FormProps) {
  const { t } = useI18n();
  const idempotencyKey = useRef(clientUuid());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(
    path: string,
    payload: Record<string, unknown>,
    successMessage: string,
  ) {
    setSaving(true);
    setError(null);
    try {
      await postJson(path, payload, idempotencyKey.current, t);
      onDirtyChange(false);
      setSaving(false);
      await onSaved(successMessage);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : t("log.form.saveFailed"),
      );
      setSaving(false);
    }
  }

  return { saving, error, submit };
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="log-form-error" role="alert">
      {message}
    </p>
  );
}

export function WorkoutLogForm(
  props: FormProps & {
    defaultTime: string;
    cycle: CyclePhase[];
    nextPhase: CyclePhase | null;
  },
) {
  const { t } = useI18n();
  const { saving, error, submit } = useRecordSubmit(props);
  const trainingPhases = props.cycle.filter((phase) => phase.kind === "training");
  const nextTrainingPhaseId =
    props.nextPhase?.kind === "training" ? props.nextPhase.id : "";
  const defaultTrainingPhaseId = trainingPhases.some(
    (phase) => phase.id === nextTrainingPhaseId,
  )
    ? nextTrainingPhaseId
    : "";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const durationMinutes = Number(form.get("durationMinutes"));
    await submit(
      "/api/fitness/workout-sessions",
      {
        title: requiredText(form, "title"),
        type: requiredText(form, "type"),
        startedAt: timestampForTimezone(
          props.date,
          requiredText(form, "time"),
          props.timezone,
        ),
        timePrecision: "minute",
        durationSeconds: Math.round(durationMinutes * 60),
        sessionIntent: requiredText(form, "sessionIntent"),
        trainingPhaseId: optionalText(form, "trainingPhaseId"),
        activeCaloriesKcal: optionalNumber(form, "activeCaloriesKcal"),
        effortRaw: optionalText(form, "effortRaw"),
        venueManual: optionalText(form, "venueManual"),
        notesManual: optionalText(form, "notesManual"),
        source: "Open Fitness WebApp",
        sets: [],
      },
      t("log.form.workout.saved"),
    );
  }

  return (
    <form
      className="log-form"
      onChangeCapture={() => props.onDirtyChange(true)}
      onSubmit={handleSubmit}
    >
      <div className="log-form-grid">
        <label className="log-field log-field-wide">
          <span>{t("log.form.workout.name")}</span>
          <input
            name="title"
            required
            maxLength={120}
            placeholder={t("log.form.workout.namePlaceholder")}
          />
        </label>
        <label className="log-field">
          <span>{t("log.form.workout.intent")}</span>
          <select name="sessionIntent" defaultValue="normal">
            <option value="normal">{t("log.form.workout.intentNormal")}</option>
            <option value="deload">{t("log.form.workout.intentDeload")}</option>
            <option value="test">{t("log.form.workout.intentTest")}</option>
          </select>
        </label>
        <label className="log-field">
          <span>{t("log.form.workout.type")}</span>
          <select name="type" defaultValue="Strength">
            <option value="Strength">{t("log.form.workout.typeStrength")}</option>
            <option value="Cardio">{t("log.form.workout.typeCardio")}</option>
            <option value="Mobility">{t("log.form.workout.typeMobility")}</option>
            <option value="Sport">{t("log.form.workout.typeSport")}</option>
            <option value="Other">{t("log.form.workout.typeOther")}</option>
          </select>
        </label>
        <label className="log-field">
          <span>{t("log.form.workout.cycleDay")}</span>
          <select name="trainingPhaseId" defaultValue={defaultTrainingPhaseId}>
            <option value="">{t("log.form.workout.noCycle")}</option>
            {trainingPhases.map((phase) => (
              <option key={phase.id} value={phase.id}>
                {phase.raw}
              </option>
            ))}
          </select>
        </label>
        <label className="log-field">
          <span>{t("log.form.time")}</span>
          <input name="time" type="time" required defaultValue={props.defaultTime} />
        </label>
        <label className="log-field">
          <span>{t("log.form.duration")}</span>
          <input
            name="durationMinutes"
            type="number"
            inputMode="numeric"
            min="0"
            max="1440"
            step="1"
            required
            defaultValue="60"
          />
        </label>
        <label className="log-field">
          <span>{t("log.form.activeCalories")}</span>
          <input
            name="activeCaloriesKcal"
            type="number"
            inputMode="decimal"
            min="0"
            step="1"
            placeholder={t("log.form.optional")}
          />
        </label>
        <label className="log-field">
          <span>{t("log.form.effort")}</span>
          <input
            name="effortRaw"
            maxLength={80}
            placeholder={t("log.form.effortPlaceholder")}
          />
        </label>
        <label className="log-field">
          <span>{t("log.form.venue")}</span>
          <input
            name="venueManual"
            maxLength={120}
            placeholder={t("log.form.optional")}
          />
        </label>
        <label className="log-field log-field-wide">
          <span>{t("log.form.notes")}</span>
          <textarea name="notesManual" maxLength={1000} rows={3} />
        </label>
      </div>
      <p className="log-form-hint">{t("log.form.workout.hint")}</p>
      <FormError message={error} />
      <button className="log-save-button" type="submit" disabled={saving}>
        {saving ? t("common.saving") : t("log.form.workout.save")}
      </button>
    </form>
  );
}

export function BodyLogForm(props: FormProps & { defaultTime: string }) {
  const { t } = useI18n();
  const { saving, error, submit } = useRecordSubmit(props);
  const measurementId = useRef(`MANUAL|${clientUuid()}`);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const measuredAt = timestampForTimezone(
      props.date,
      requiredText(form, "time"),
      props.timezone,
    );
    await submit(
      "/api/fitness/body-measurements",
      {
        measurementId: measurementId.current,
        measuredAt,
        sourceDevice: "Manual entry",
        sourceFile: "Open Fitness WebApp",
        weightKg: Number(form.get("weightKg")),
        bodyFatPct: optionalNumber(form, "bodyFatPct"),
        muscleMassKg: optionalNumber(form, "muscleMassKg"),
        bmrKcalPerDay: optionalNumber(form, "bmrKcalPerDay"),
      },
      t("log.form.body.saved"),
    );
  }

  return (
    <form
      className="log-form"
      onChangeCapture={() => props.onDirtyChange(true)}
      onSubmit={handleSubmit}
    >
      <div className="log-form-grid">
        <label className="log-field">
          <span>{t("log.form.time")}</span>
          <input name="time" type="time" required defaultValue={props.defaultTime} />
        </label>
        <label className="log-field">
          <span>{t("log.form.body.weight")}</span>
          <input
            name="weightKg"
            type="number"
            inputMode="decimal"
            min="20"
            max="350"
            step="0.1"
            required
          />
        </label>
        <label className="log-field">
          <span>{t("log.form.body.bodyFat")}</span>
          <input
            name="bodyFatPct"
            type="number"
            inputMode="decimal"
            min="0"
            max="100"
            step="0.1"
            placeholder={t("log.form.optional")}
          />
        </label>
      </div>
      <details className="log-form-details">
        <summary>{t("log.form.body.other")}</summary>
        <div className="log-form-grid">
          <label className="log-field">
            <span>{t("log.form.body.muscleMass")}</span>
            <input
              name="muscleMassKg"
              type="number"
              inputMode="decimal"
              min="0"
              max="250"
              step="0.1"
            />
          </label>
          <label className="log-field">
            <span>{t("log.form.body.bmr")}</span>
            <input
              name="bmrKcalPerDay"
              type="number"
              inputMode="numeric"
              min="500"
              max="6000"
              step="1"
            />
          </label>
        </div>
      </details>
      <FormError message={error} />
      <button className="log-save-button" type="submit" disabled={saving}>
        {saving ? t("common.saving") : t("log.form.body.save")}
      </button>
    </form>
  );
}

export function RecoveryLogForm(props: FormProps) {
  const { t } = useI18n();
  const { saving, error, submit } = useRecordSubmit(props);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await submit(
      "/api/fitness/session-notes",
      {
        noteDate: props.date,
        noteType: "Recovery status",
        exerciseOrArea: optionalText(form, "exerciseOrArea"),
        pain010: optionalNumber(form, "pain010"),
        note: requiredText(form, "note"),
        source: "Open Fitness WebApp",
      },
      t("log.form.recovery.saved"),
    );
  }

  return (
    <form
      className="log-form"
      onChangeCapture={() => props.onDirtyChange(true)}
      onSubmit={handleSubmit}
    >
      <div className="log-form-grid">
        <label className="log-field">
          <span>{t("log.form.recovery.area")}</span>
          <input
            name="exerciseOrArea"
            maxLength={120}
            placeholder={t("log.form.recovery.areaPlaceholder")}
          />
        </label>
        <label className="log-field">
          <span>{t("log.form.recovery.pain")}</span>
          <input
            name="pain010"
            type="number"
            inputMode="decimal"
            min="0"
            max="10"
            step="0.5"
            placeholder={t("log.form.optional")}
          />
        </label>
        <label className="log-field log-field-wide">
          <span>{t("log.form.recovery.status")}</span>
          <textarea name="note" required maxLength={1000} rows={5} />
        </label>
      </div>
      <FormError message={error} />
      <button className="log-save-button" type="submit" disabled={saving}>
        {saving ? t("common.saving") : t("log.form.recovery.save")}
      </button>
    </form>
  );
}

export function MealLogForm(props: FormProps & { defaultTime: string }) {
  const { t } = useI18n();
  const { saving, error, submit } = useRecordSubmit(props);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = requiredText(form, "name");
    const confidence = requiredText(form, "confidence");
    await submit(
      "/api/nutrition/meals",
      {
        localDate: props.date,
        eatenAt: timestampForTimezone(
          props.date,
          requiredText(form, "time"),
          props.timezone,
        ),
        timePrecision: "exact",
        mealType: requiredText(form, "mealType"),
        source: "site_manual",
        confidence,
        originalText: name,
        notes: optionalText(form, "notes"),
        items: [
          {
            name,
            quantity: 1,
            unit: null,
            confidence,
            nutrients: {
              energyKcal: Number(form.get("energyKcal")),
              proteinG: optionalNumber(form, "proteinG"),
              carbsG: optionalNumber(form, "carbsG"),
              totalFatG: optionalNumber(form, "totalFatG"),
            },
          },
        ],
      },
      t("log.form.meal.saved"),
    );
  }

  return (
    <form
      className="log-form"
      onChangeCapture={() => props.onDirtyChange(true)}
      onSubmit={handleSubmit}
    >
      <div className="log-form-grid">
        <label className="log-field log-field-wide">
          <span>{t("log.form.meal.name")}</span>
          <input
            name="name"
            required
            maxLength={160}
            placeholder={t("log.form.meal.namePlaceholder")}
          />
        </label>
        <label className="log-field">
          <span>{t("log.form.meal.category")}</span>
          <select name="mealType" defaultValue="lunch">
            <option value="breakfast">{t("log.form.meal.breakfast")}</option>
            <option value="lunch">{t("log.form.meal.lunch")}</option>
            <option value="dinner">{t("log.form.meal.dinner")}</option>
            <option value="snack">{t("log.form.meal.snack")}</option>
            <option value="late_night">{t("log.form.meal.lateNight")}</option>
            <option value="other">{t("log.form.meal.other")}</option>
          </select>
        </label>
        <label className="log-field">
          <span>{t("log.form.time")}</span>
          <input name="time" type="time" required defaultValue={props.defaultTime} />
        </label>
        <label className="log-field">
          <span>{t("log.form.meal.energy")}</span>
          <input
            name="energyKcal"
            type="number"
            inputMode="decimal"
            min="0"
            max="50000"
            step="1"
            required
          />
        </label>
        <label className="log-field">
          <span>{t("log.form.meal.protein")}</span>
          <input
            name="proteinG"
            type="number"
            inputMode="decimal"
            min="0"
            max="50000"
            step="0.1"
            placeholder={t("log.form.optional")}
          />
        </label>
      </div>
      <details className="log-form-details">
        <summary>{t("log.form.meal.moreNutrition")}</summary>
        <div className="log-form-grid">
          <label className="log-field">
            <span>{t("log.form.meal.carbs")}</span>
            <input
              name="carbsG"
              type="number"
              inputMode="decimal"
              min="0"
              max="50000"
              step="0.1"
            />
          </label>
          <label className="log-field">
            <span>{t("log.form.meal.fat")}</span>
            <input
              name="totalFatG"
              type="number"
              inputMode="decimal"
              min="0"
              max="50000"
              step="0.1"
            />
          </label>
          <label className="log-field">
            <span>{t("log.form.meal.confidence")}</span>
            <select name="confidence" defaultValue="medium">
              <option value="high">{t("log.form.confidence.high")}</option>
              <option value="medium">{t("log.form.confidence.medium")}</option>
              <option value="low">{t("log.form.confidence.low")}</option>
            </select>
          </label>
          <label className="log-field log-field-wide">
            <span>{t("log.form.notes")}</span>
            <textarea name="notes" maxLength={1000} rows={3} />
          </label>
        </div>
      </details>
      <FormError message={error} />
      <button className="log-save-button" type="submit" disabled={saving}>
        {saving ? t("common.saving") : t("log.form.meal.save")}
      </button>
    </form>
  );
}
