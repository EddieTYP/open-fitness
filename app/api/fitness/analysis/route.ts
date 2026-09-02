import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  like,
  lte,
  sql,
} from "drizzle-orm";
import { getDb } from "@/db";
import {
  bodyMeasurements,
  corrections,
  dataPolicies,
  decisionRules,
  evidenceBase,
  exerciseAliases,
  nutritionEnergyObservations,
  nutritionMealItems,
  nutritionMealRevisions,
  nutritionMeals,
  nutritionSettings,
  operatingConstraints,
  profile,
  sessionNotes,
  trainingScheduleEvents,
  workoutSessions,
  workoutSets,
} from "@/db/schema";
import {
  getApiActor,
  routeError,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { apiError } from "@/lib/api-error";
import { canonicalExerciseIdentity } from "@/lib/exercise-display";
import { profileResponse } from "@/lib/profile-settings";
import { getProfileTimezone } from "@/lib/profile-timezone";
import { chunkByParameterLimit } from "@/lib/d1-limits";
import { isDateOnly } from "@/lib/record-utils";
import { projectOperatingConstraintCorrections } from "@/lib/operating-constraint-corrections";
import { deriveTrainingSchedule } from "@/lib/training-schedule";
import { dateInTimeZone } from "@/lib/timezone.mjs";
import { effectiveWorkoutRecords } from "@/lib/workout-corrections";

export const dynamic = "force-dynamic";

const analysisViews = new Set(["default", "full"]);
const leanAnalysisOmissions = new Set([
  "profileId",
  "measurementId",
  "metabolicAgeYears",
  "physiqueRating",
  "muscleMassRightArmKg",
  "muscleMassLeftArmKg",
  "muscleMassRightLegKg",
  "muscleMassLeftLegKg",
  "muscleMassTrunkKg",
  "muscleQualityRightArm",
  "muscleQualityLeftArm",
  "muscleQualityRightLeg",
  "muscleQualityLeftLeg",
  "muscleQualityTrunk",
  "bodyFatRightArmPct",
  "bodyFatLeftArmPct",
  "bodyFatRightLegPct",
  "bodyFatLeftLegPct",
  "bodyFatTrunkPct",
  "setId",
  "noteId",
  "correctionId",
  "ruleId",
  "evidenceId",
  "mealId",
  "mealItemId",
  "foodId",
  "foodVersionId",
  "energyObservationId",
  "settingsId",
  "source",
  "sourceFile",
  "sourceDevice",
  "createdAt",
  "createdBy",
  "updatedAt",
  "startedAtUtc",
  "evidenceBase",
  "dataPolicies",
  "operatingConstraintHistory",
]);
const analysisCollectionLimits = {
  bodyMeasurements: 200,
  workoutSessions: 300,
  workoutSets: 3000,
  sessionNotes: 500,
  corrections: 1000,
  exerciseAliases: 500,
  meals: 1000,
  mealItems: 5000,
  energyObservations: 500,
} as const;
const maxAnalysisResponseBytes = 524_288;

function shapeAnalysis(value: unknown, view: "default" | "full"): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => shapeAnalysis(item, view));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, item]) =>
          view === "full" ||
          (item !== null && !leanAnalysisOmissions.has(key)),
      )
      .map(([key, item]) => [key, shapeAnalysis(item, view)]),
  );
}

function oversizedCollection(
  collections: Record<keyof typeof analysisCollectionLimits, unknown[]>,
) {
  return Object.entries(analysisCollectionLimits).find(
    ([key, maximum]) =>
      collections[key as keyof typeof analysisCollectionLimits].length > maximum,
  );
}

function dateDaysAgo(localDate: string, days: number) {
  const date = new Date(`${localDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function rangeDays(from: string, to: string) {
  return (
    Math.round(
      (Date.parse(`${to}T00:00:00Z`) -
        Date.parse(`${from}T00:00:00Z`)) /
        86_400_000,
    ) + 1
  );
}

export async function GET(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const timezone = await getProfileTimezone();
    const url = new URL(request.url);
    const to =
      url.searchParams.get("to") || dateInTimeZone(new Date(), timezone);
    const from = url.searchParams.get("from") || dateDaysAgo(to, 83);
    const exercise = url.searchParams.get("exercise")?.trim() || null;
    const viewValue = url.searchParams.get("view") ?? "default";
    if (!analysisViews.has(viewValue)) {
      return apiError(
        "INVALID_ANALYSIS_VIEW",
        400,
        { view: viewValue, allowedViews: [...analysisViews] },
        "Invalid analysis view",
      );
    }
    const view = viewValue as "default" | "full";
    if (!isDateOnly(from) || !isDateOnly(to) || from > to) {
      return apiError(
        "INVALID_ANALYSIS_DATE_RANGE",
        400,
        { from, to },
        "Invalid analysis date range",
      );
    }
    const requestedDays = rangeDays(from, to);
    if (requestedDays > 120) {
      return apiError(
        "ANALYSIS_DATE_RANGE_TOO_LARGE",
        400,
        { maximumDays: 120, requestedDays },
        "Analysis date range is too large",
      );
    }

    const db = getDb();
    const localDateRange = (column: { name: string }) =>
      sql`${column} BETWEEN ${from} AND ${to}`;

    const [
      profileRows,
      measurementRows,
      rawSessionRows,
      noteRows,
      constraintRows,
      correctionRows,
      aliasRows,
      decisionRuleRows,
      evidenceRows,
      policyRows,
      settingRows,
      mealRows,
      energyRows,
      trainingScheduleRows,
    ] = await Promise.all([
      db.select().from(profile).limit(1),
      db
        .select()
        .from(bodyMeasurements)
        .where(localDateRange(bodyMeasurements.localDate))
        .orderBy(
          asc(bodyMeasurements.localDate),
          asc(bodyMeasurements.measuredAt),
        ),
      db
        .select()
        .from(workoutSessions)
        .where(
          and(
            localDateRange(workoutSessions.localDate),
            isNull(workoutSessions.voidedAt),
          ),
        )
        .orderBy(
          asc(workoutSessions.startedAtUtc),
          asc(workoutSessions.startedAt),
        ),
      db
        .select()
        .from(sessionNotes)
        .where(
          and(
            sql`${sessionNotes.noteDate} >= ${from}`,
            sql`${sessionNotes.noteDate} <= ${to}`,
            sql`(${sessionNotes.sessionId} IS NULL OR NOT EXISTS (
              SELECT 1 FROM workout_sessions hidden_session
              WHERE hidden_session.session_id = ${sessionNotes.sessionId}
                AND hidden_session.voided_at IS NOT NULL
            ))`,
          ),
        )
        .orderBy(asc(sessionNotes.noteDate), asc(sessionNotes.createdAt)),
      db.select().from(operatingConstraints).orderBy(asc(operatingConstraints.item)),
      db
        .select()
        .from(corrections)
        .where(sql`
          NOT (
            ${corrections.targetScope} = 'workout_session'
            AND EXISTS (
              SELECT 1 FROM workout_sessions hidden_session
              WHERE hidden_session.session_id = ${corrections.targetKey}
                AND hidden_session.voided_at IS NOT NULL
            )
          )
          AND NOT (
            ${corrections.targetScope} = 'workout_set'
            AND EXISTS (
              SELECT 1
              FROM workout_sets hidden_set
              INNER JOIN workout_sessions hidden_session
                ON hidden_session.session_id = hidden_set.session_id
              WHERE hidden_set.set_id = ${corrections.targetKey}
                AND hidden_session.voided_at IS NOT NULL
            )
          )
        `)
        .orderBy(
          asc(corrections.effectiveDate),
          asc(corrections.recordedAt),
        ),
      db.select().from(exerciseAliases).orderBy(asc(exerciseAliases.sourceExerciseName)),
      view === "full"
        ? db.select().from(decisionRules).orderBy(asc(decisionRules.domain))
        : Promise.resolve([] as Array<typeof decisionRules.$inferSelect>),
      view === "full"
        ? db.select().from(evidenceBase).orderBy(asc(evidenceBase.evidenceId))
        : Promise.resolve([] as Array<typeof evidenceBase.$inferSelect>),
      view === "full"
        ? db.select().from(dataPolicies).orderBy(asc(dataPolicies.policyKey))
        : Promise.resolve([] as Array<typeof dataPolicies.$inferSelect>),
      db
        .select()
        .from(nutritionSettings)
        .where(lte(nutritionSettings.effectiveFrom, to))
        .orderBy(desc(nutritionSettings.effectiveFrom)),
      db
        .select({
          meal: getTableColumns(nutritionMeals),
          revision: getTableColumns(nutritionMealRevisions),
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
            sql`${nutritionMeals.localDate} >= ${from}`,
            sql`${nutritionMeals.localDate} <= ${to}`,
            isNull(nutritionMeals.voidedAt),
          ),
        )
        .orderBy(
          asc(nutritionMeals.localDate),
          asc(nutritionMeals.eatenAt),
          asc(nutritionMeals.createdAt),
        ),
      db
        .select()
        .from(nutritionEnergyObservations)
        .where(
          and(
            sql`${nutritionEnergyObservations.localDate} >= ${from}`,
            sql`${nutritionEnergyObservations.localDate} <= ${to}`,
          ),
        )
        .orderBy(
          asc(nutritionEnergyObservations.localDate),
          asc(nutritionEnergyObservations.observedAt),
          asc(nutritionEnergyObservations.createdAt),
        ),
      db
        .select()
        .from(trainingScheduleEvents)
        .where(isNull(trainingScheduleEvents.voidedAt))
        .orderBy(
          asc(trainingScheduleEvents.effectiveDate),
          asc(trainingScheduleEvents.recordedAt),
          asc(trainingScheduleEvents.eventId),
        ),
    ]);

    const sessionIds = rawSessionRows.map((session) => session.sessionId);
    const rawSetRows: Array<typeof workoutSets.$inferSelect> = [];
    for (const sessionIdChunk of chunkByParameterLimit(sessionIds)) {
      rawSetRows.push(
        ...(await db
          .select()
          .from(workoutSets)
          .where(inArray(workoutSets.sessionId, sessionIdChunk))),
      );
    }
    const projectedWorkout = await effectiveWorkoutRecords(
      { sessions: rawSessionRows, sets: rawSetRows },
      db,
    );
    const projectedConstraints = projectOperatingConstraintCorrections(
      constraintRows,
      correctionRows,
      to,
    );
    const relevantSessionIds = new Set(rawSessionRows.map((row) => row.sessionId));
    const relevantSetIds = new Set(rawSetRows.map((row) => row.setId));
    const visibleCorrectionRows = correctionRows.filter((correction) => {
      if (correction.targetScope === "operating_constraint") {
        return correction.effectiveDate <= to;
      }
      if (correction.targetScope === "workout_session") {
        return relevantSessionIds.has(correction.targetKey);
      }
      if (correction.targetScope === "workout_set") {
        return relevantSetIds.has(correction.targetKey);
      }
      if (correction.targetScope === "calendar_day") {
        return correction.effectiveDate >= from && correction.effectiveDate <= to;
      }
      return false;
    });
    const sessionRows = projectedWorkout.sessions;
    const exerciseIdentity = exercise
      ? canonicalExerciseIdentity(exercise)
      : null;
    const allSetRows = exerciseIdentity
      ? projectedWorkout.sets.filter(
          (set) =>
            canonicalExerciseIdentity(set.exercise) === exerciseIdentity,
        )
      : projectedWorkout.sets;
    allSetRows.sort(
      (left, right) =>
        left.sessionId.localeCompare(right.sessionId) ||
        left.setNoSession - right.setNoSession,
    );
    const includedSessionIds = exerciseIdentity
      ? new Set(allSetRows.map((set) => set.sessionId))
      : null;
    const includedSessions = includedSessionIds
      ? sessionRows.filter((session) =>
          includedSessionIds.has(session.sessionId),
        )
      : sessionRows;

    const revisionIds = mealRows.map(
      ({ revision }) => revision.mealRevisionId,
    );
    const mealItemRows: Array<typeof nutritionMealItems.$inferSelect> = [];
    for (const revisionIdChunk of chunkByParameterLimit(revisionIds)) {
      mealItemRows.push(
        ...(await db
          .select()
          .from(nutritionMealItems)
          .where(
            inArray(
              nutritionMealItems.mealRevisionId,
              revisionIdChunk,
            ),
          )),
      );
    }
    mealItemRows.sort(
      (left, right) =>
        left.mealRevisionId.localeCompare(right.mealRevisionId) ||
        left.itemOrdinal - right.itemOrdinal,
    );

    let exerciseSuggestions: string[] = [];
    if (exercise && allSetRows.length === 0) {
      const rawSuggestionRows = await db
        .select({
          setId: workoutSets.setId,
          exercise: workoutSets.exercise,
        })
        .from(workoutSets)
        .innerJoin(
          workoutSessions,
          eq(workoutSets.sessionId, workoutSessions.sessionId),
        )
        .where(
          and(
            like(workoutSets.exercise, `%${exercise}%`),
            isNull(workoutSessions.voidedAt),
          ),
        )
        .limit(200);
      const correctedCandidateIds = correctionRows
        .filter(
          (correction) =>
            correction.targetScope === "workout_set" &&
            correction.fieldName === "exercise" &&
            correction.correctedValue
              ?.toLocaleLowerCase()
              .includes(exercise.toLocaleLowerCase()),
        )
        .map((correction) => correction.targetKey);
      const correctedSuggestionRows: Array<{
        setId: string;
        exercise: string;
      }> = [];
      for (const targetIdChunk of chunkByParameterLimit(correctedCandidateIds)) {
        correctedSuggestionRows.push(
          ...(await db
            .select({
              setId: workoutSets.setId,
              exercise: workoutSets.exercise,
            })
            .from(workoutSets)
            .innerJoin(
              workoutSessions,
              eq(workoutSets.sessionId, workoutSessions.sessionId),
            )
            .where(
              and(
                inArray(workoutSets.setId, targetIdChunk),
                isNull(workoutSessions.voidedAt),
              ),
            )),
        );
      }
      const suggestionCandidates = [...new Map(
        [...rawSuggestionRows, ...correctedSuggestionRows].map((set) => [
          set.setId,
          set,
        ]),
      ).values()];
      const projectedSuggestions = await effectiveWorkoutRecords(
        { sets: suggestionCandidates },
        db,
      );
      exerciseSuggestions = [...new Set(
        projectedSuggestions.sets
          .map((set) => set.exercise)
          .filter((name) =>
            name.toLocaleLowerCase().includes(exercise.toLocaleLowerCase()),
          ),
      )]
        .sort((left, right) => left.localeCompare(right))
        .slice(0, 20);
    }

    const cutoffCandidates = [
      measurementRows.at(-1)?.localDate,
      sessionRows.at(-1)?.localDate,
      mealRows.at(-1)?.meal.localDate,
      energyRows.at(-1)?.localDate,
    ].filter((value): value is string => Boolean(value));
    const planningDate = dateInTimeZone(new Date(), timezone);
    const currentProfile = profileRows[0];
    const schedule = deriveTrainingSchedule(
      currentProfile
        ? trainingScheduleRows.filter(
            (event) => event.profileId === currentProfile.profileId,
          )
        : [],
      planningDate,
    );

    const returnedCorrections =
      view === "full"
        ? visibleCorrectionRows
        : visibleCorrectionRows.filter(
            (correction) =>
              correction.targetScope !== "operating_constraint",
          );
    const relevantExercises = new Set([
      ...allSetRows.map((set) => set.exercise),
      ...(exercise ? [exercise] : []),
    ]);
    const returnedAliases =
      view === "full"
        ? aliasRows
        : aliasRows.filter(
            (alias) =>
              relevantExercises.has(alias.sourceExerciseName) ||
              relevantExercises.has(alias.canonicalName),
          );
    const collections = {
      bodyMeasurements: measurementRows,
      workoutSessions: includedSessions,
      workoutSets: allSetRows,
      sessionNotes: noteRows,
      corrections: returnedCorrections,
      exerciseAliases: returnedAliases,
      meals: mealRows,
      mealItems: mealItemRows,
      energyObservations: energyRows,
    };
    const oversized = oversizedCollection(collections);
    if (oversized) {
      const [collection, maximum] = oversized;
      return apiError(
        "ANALYSIS_RESULT_TOO_LARGE",
        400,
        {
          collection,
          maximum,
          actual:
            collections[collection as keyof typeof collections].length,
          from,
          to,
        },
        "Analysis result is too large; use a narrower date range",
      );
    }

    const responseData = shapeAnalysis(
      {
        actor: actor.kind,
        generatedAt: new Date().toISOString(),
        timezone,
        range: { from, to, days: rangeDays(from, to), exercise },
        dataCutoff:
          cutoffCandidates.sort((left, right) =>
            left.localeCompare(right),
          ).at(-1) ?? null,
        trainingSchedule: {
          status: schedule.status,
          planningDate,
          pause: schedule.pause
            ? {
                startsOn: schedule.pause.startsOn,
                resumeOn: schedule.pause.resumeOn,
                reason: schedule.pause.reason,
              }
            : null,
        },
        profile: currentProfile ? profileResponse(currentProfile) : null,
        bodyMeasurements: measurementRows.map(({ sourceFile, ...measurement }) => ({
          ...measurement,
          source: sourceFile,
        })),
        workoutSessions: includedSessions,
        workoutSets: allSetRows,
        sessionNotes: noteRows,
        corrections: returnedCorrections,
        exerciseAliases: returnedAliases,
        operatingConstraints: projectedConstraints.constraints,
        operatingConstraintHistory: constraintRows,
        decisionRules: decisionRuleRows,
        evidenceBase: evidenceRows,
        dataPolicies: policyRows,
        nutrition: {
          meals: mealRows,
          mealItems: mealItemRows,
          energyObservations: energyRows,
          settings: settingRows,
        },
        exerciseSuggestions,
      },
      view,
    );
    const serialized = JSON.stringify(responseData);
    if (new TextEncoder().encode(serialized).byteLength > maxAnalysisResponseBytes) {
      return apiError(
        "ANALYSIS_RESULT_TOO_LARGE",
        400,
        { maximumBytes: maxAnalysisResponseBytes, from, to },
        "Analysis result is too large; use a narrower date range",
      );
    }
    return new Response(serialized, {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
      },
    });
  } catch (error) {
    return routeError(error);
  }
}
