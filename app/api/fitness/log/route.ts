import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import {
  bodyMeasurements,
  nutritionMealItems,
  nutritionMealRevisions,
  nutritionMeals,
  sessionNotes,
  workoutSessions,
} from "@/db/schema";
import {
  getApiActor,
  routeError,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { apiError } from "@/lib/api-error";
import {
  messageText,
  sourceText,
  type UiText,
} from "@/lib/i18n/ui-text";
import { workoutTypeText } from "@/lib/i18n/workout-type";
import { isDateOnly } from "@/lib/record-utils";
import { effectiveWorkoutRecords } from "@/lib/workout-corrections";

export const dynamic = "force-dynamic";

const MAX_RECORDS_PER_KIND = 80;

export type FitnessLogRecord = {
  id: string;
  kind: "workout" | "body" | "recovery" | "meal";
  occurredAt: string | null;
  recordedAt: string;
  timePrecision: "exact" | "minute" | "date_only";
  title: UiText;
  summary: UiText | null;
  metrics: UiText[];
  intent?: "normal" | "deload" | "test";
};

function compactText(value: string | null | undefined, maxLength = 120) {
  if (!value) return null;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  return compact.length > maxLength
    ? `${compact.slice(0, maxLength - 1).trimEnd()}…`
    : compact;
}

function metric(key: string, value: number | null, digits = 0) {
  if (value === null) return null;
  const scale = 10 ** digits;
  return messageText(key, { value: Math.round(value * scale) / scale });
}

function newestFirst(left: FitnessLogRecord, right: FitnessLogRecord) {
  if (left.occurredAt && !right.occurredAt) return -1;
  if (!left.occurredAt && right.occurredAt) return 1;
  if (left.occurredAt && right.occurredAt) {
    const difference = Date.parse(right.occurredAt) - Date.parse(left.occurredAt);
    if (difference !== 0) return difference;
  }
  return right.recordedAt.localeCompare(left.recordedAt);
}

const mealTypeMessageKeys: Record<string, string> = {
  breakfast: "log.record.mealType.breakfast",
  lunch: "log.record.mealType.lunch",
  dinner: "log.record.mealType.dinner",
  snack: "log.record.mealType.snack",
  late_night: "log.record.mealType.lateNight",
  other: "log.record.mealType.other",
};

function mealTypeText(mealType: string) {
  return messageText(
    mealTypeMessageKeys[mealType] ?? "log.record.mealType.unknown",
  );
}

export async function GET(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const searchParams = new URL(request.url).searchParams;
    const unknownParameters = [...searchParams.keys()].filter(
      (key) => key !== "date",
    );
    if (unknownParameters.length > 0) {
      return apiError(
        "UNKNOWN_LOG_QUERY_PARAMETER",
        400,
        { parameters: unknownParameters },
        "Unknown log query parameter",
      );
    }

    const date = searchParams.get("date");
    if (!date || !isDateOnly(date)) {
      return apiError(
        "INVALID_LOG_DATE",
        400,
        { field: "date" },
        "Invalid log date",
      );
    }

    const db = getDb();
    const [rawWorkouts, measurements, notes, meals] = await Promise.all([
      db
        .select({
          sessionId: workoutSessions.sessionId,
          occurredAt: workoutSessions.startedAt,
          recordedAt: workoutSessions.createdAt,
          timePrecision: workoutSessions.timePrecision,
          sessionTitle: workoutSessions.sessionTitle,
          type: workoutSessions.sessionType,
          durationSeconds: workoutSessions.durationSeconds,
          sets: workoutSessions.totalSetsReported,
          calories: workoutSessions.activeCaloriesKcal,
          reportedCalories: workoutSessions.burnedCaloriesKcalReported,
          effort: workoutSessions.effortRaw,
          notes: workoutSessions.notesManual,
          intent: workoutSessions.sessionIntent,
        })
        .from(workoutSessions)
        .where(
          and(
            eq(workoutSessions.localDate, date),
            isNull(workoutSessions.voidedAt),
          ),
        )
        .orderBy(
          desc(workoutSessions.startedAt),
          desc(workoutSessions.createdAt),
        )
        .limit(MAX_RECORDS_PER_KIND),
      db
        .select({
          id: bodyMeasurements.measurementId,
          occurredAt: bodyMeasurements.measuredAt,
          recordedAt: bodyMeasurements.createdAt,
          weightKg: bodyMeasurements.weightKg,
          bodyFatPct: bodyMeasurements.bodyFatPct,
          muscleMassKg: bodyMeasurements.muscleMassKg,
          bmrKcalPerDay: bodyMeasurements.bmrKcalPerDay,
        })
        .from(bodyMeasurements)
        .where(eq(bodyMeasurements.localDate, date))
        .orderBy(
          desc(bodyMeasurements.measuredAt),
          desc(bodyMeasurements.createdAt),
        )
        .limit(MAX_RECORDS_PER_KIND),
      db
        .select({
          id: sessionNotes.noteId,
          recordedAt: sessionNotes.createdAt,
          noteType: sessionNotes.noteType,
          area: sessionNotes.exerciseOrArea,
          pain010: sessionNotes.pain010,
          note: sessionNotes.note,
        })
        .from(sessionNotes)
        .where(
          and(
            eq(sessionNotes.noteDate, date),
            eq(sessionNotes.noteType, "Recovery status"),
          ),
        )
        .orderBy(desc(sessionNotes.createdAt))
        .limit(MAX_RECORDS_PER_KIND),
      db
        .select({
          id: nutritionMeals.mealId,
          occurredAt: nutritionMeals.eatenAt,
          recordedAt: nutritionMeals.createdAt,
          timePrecision: nutritionMeals.timePrecision,
          mealType: nutritionMeals.mealType,
          revisionId: nutritionMealRevisions.mealRevisionId,
          originalText: nutritionMealRevisions.originalText,
          notes: nutritionMealRevisions.notes,
          energyKcal: nutritionMealRevisions.energyKcal,
          proteinG: nutritionMealRevisions.proteinG,
        })
        .from(nutritionMeals)
        .innerJoin(
          nutritionMealRevisions,
          and(
            eq(nutritionMealRevisions.mealId, nutritionMeals.mealId),
            eq(
              nutritionMealRevisions.revisionNo,
              nutritionMeals.currentRevisionNo,
            ),
          ),
        )
        .where(
          and(
            eq(nutritionMeals.localDate, date),
            isNull(nutritionMeals.voidedAt),
          ),
        )
        .orderBy(
          desc(nutritionMeals.eatenAt),
          desc(nutritionMeals.createdAt),
        )
        .limit(MAX_RECORDS_PER_KIND),
    ]);
    const { sessions: workouts } = await effectiveWorkoutRecords(
      { sessions: rawWorkouts },
      db,
    );

    const revisionIds = meals.map((meal) => meal.revisionId);
    const mealItems =
      revisionIds.length === 0
        ? []
        : await db
            .select({
              revisionId: nutritionMealItems.mealRevisionId,
              ordinal: nutritionMealItems.itemOrdinal,
              name: nutritionMealItems.itemNameSnapshot,
            })
            .from(nutritionMealItems)
            .where(inArray(nutritionMealItems.mealRevisionId, revisionIds));
    const itemNamesByRevision = new Map<string, string[]>();
    for (const item of mealItems.sort(
      (left, right) => left.ordinal - right.ordinal,
    )) {
      const names = itemNamesByRevision.get(item.revisionId) ?? [];
      names.push(item.name);
      itemNamesByRevision.set(item.revisionId, names);
    }

    const records: FitnessLogRecord[] = [
      ...workouts.map((workout) => {
        const notes = compactText(workout.notes);
        const type = compactText(workout.type);
        const effort = compactText(workout.effort, 32);
        return {
          id: workout.sessionId,
          kind: "workout" as const,
          occurredAt: workout.occurredAt,
          recordedAt: workout.recordedAt,
          timePrecision:
            workout.timePrecision === "exact"
              ? ("exact" as const)
              : ("minute" as const),
          title: sourceText(workout.sessionTitle),
          summary: notes
            ? sourceText(notes)
            : type
              ? workoutTypeText(type)
              : null,
          metrics: [
            workout.durationSeconds > 0
              ? messageText("log.record.duration", {
                  value: Math.round(workout.durationSeconds / 60),
                })
              : null,
            workout.sets > 0
              ? messageText("log.record.sets", { value: workout.sets })
              : null,
            metric(
              "log.record.energyKcal",
              workout.calories ?? workout.reportedCalories,
            ),
            effort ? sourceText(effort) : null,
          ].filter((value): value is UiText => value !== null),
          intent: workout.intent,
        };
      }),
      ...measurements.map((measurement) => ({
        id: measurement.id,
        kind: "body" as const,
        occurredAt: measurement.occurredAt,
        recordedAt: measurement.recordedAt,
        timePrecision: "exact" as const,
        title: messageText("log.record.body.title"),
        summary: metric("log.record.body.weight", measurement.weightKg, 1),
        metrics: [
          metric("log.record.body.bodyFat", measurement.bodyFatPct, 1),
          metric("log.record.body.muscleMass", measurement.muscleMassKg, 1),
          metric("log.record.body.bmr", measurement.bmrKcalPerDay),
        ].filter((value): value is UiText => value !== null),
      })),
      ...notes.map((note) => {
        const area = compactText(note.area, 48);
        const summary = compactText(note.note);
        const unknownNoteType = /^recovery/i.test(note.noteType)
          ? null
          : compactText(note.noteType, 32);
        return {
          id: note.id,
          kind: "recovery" as const,
          occurredAt: null,
          recordedAt: note.recordedAt,
          timePrecision: "date_only" as const,
          title: area
            ? sourceText(area)
            : messageText("log.record.recovery.title"),
          summary: summary ? sourceText(summary) : null,
          metrics: [
            note.pain010 === null
              ? null
              : messageText("log.record.recovery.pain", {
                  value: note.pain010,
                }),
            unknownNoteType ? sourceText(unknownNoteType) : null,
          ].filter((value): value is UiText => value !== null),
        };
      }),
      ...meals.map((meal) => {
        const names = itemNamesByRevision.get(meal.revisionId) ?? [];
        const visibleNames = names.slice(0, 2).join(", ");
        const extraCount = Math.max(0, names.length - 2);
        const itemTitle = visibleNames
          ? `${visibleNames}${extraCount > 0 ? ` +${extraCount}` : ""}`
          : null;
        const originalText = compactText(meal.originalText, 64);
        const notes = compactText(meal.notes, 48);
        const mealType = mealTypeText(meal.mealType);
        return {
          id: meal.id,
          kind: "meal" as const,
          occurredAt: meal.occurredAt,
          recordedAt: meal.recordedAt,
          timePrecision:
            meal.timePrecision === "date_only"
              ? ("date_only" as const)
              : ("exact" as const),
          title:
            itemTitle
              ? sourceText(itemTitle)
              : originalText
                ? sourceText(originalText)
                : mealType,
          summary: mealType,
          metrics: [
            metric("log.record.energyKcal", meal.energyKcal),
            metric("log.record.meal.protein", meal.proteinG, 1),
            notes ? sourceText(notes) : null,
          ].filter((value): value is UiText => value !== null),
        };
      }),
    ].sort(newestFirst);

    return Response.json(
      {
        date,
        order: "latest_first",
        records,
        truncated:
          workouts.length === MAX_RECORDS_PER_KIND ||
          measurements.length === MAX_RECORDS_PER_KIND ||
          notes.length === MAX_RECORDS_PER_KIND ||
          meals.length === MAX_RECORDS_PER_KIND,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return routeError(error);
  }
}
