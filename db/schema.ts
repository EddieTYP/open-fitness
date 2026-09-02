import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import {
  DEFAULT_APP_LOCALE,
  type AppLocale,
} from "../lib/i18n/locales";

const createdAt = () =>
  text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`);

export const schemaMetadata = sqliteTable(
  "schema_metadata",
  {
    schemaVersion: integer("schema_version").primaryKey(),
    databaseName: text("database_name").notNull(),
    canonicalMaster: integer("canonical_master").notNull().default(1),
    timezone: text("timezone").notNull().default("Asia/Hong_Kong"),
    createdAt: createdAt(),
    sourceWorkbookSha256: text("source_workbook_sha256").notNull().default(""),
  },
  (table) => [
    check(
      "schema_metadata_canonical_master_boolean",
      sql`${table.canonicalMaster} IN (0, 1)`,
    ),
  ],
);

export const profile = sqliteTable("profile", {
  profileId: text("profile_id").primaryKey(),
  displayName: text("display_name"),
  primaryGoal: text("primary_goal").notNull(),
  goalType: text("goal_type").$type<
    | "fat_loss"
    | "muscle_gain"
    | "strength"
    | "endurance"
    | "maintenance"
    | "general"
  >(),
  trainingCycle: text("training_cycle").notNull(),
  trainingCycleConfig: text("training_cycle_config"),
  strengthProgressExercise: text("strength_progress_exercise"),
  heightCm: real("height_cm"),
  timezone: text("timezone").notNull().default("Asia/Hong_Kong"),
  preferredLocale: text("preferred_locale")
    .$type<AppLocale>()
    .notNull()
    .default(DEFAULT_APP_LOCALE),
  ownerEmail: text("owner_email"),
  setupCompleted: integer("setup_completed", { mode: "boolean" })
    .notNull()
    .default(false),
  updatedAt: text("updated_at").notNull(),
});

export const trainingBlocks = sqliteTable(
  "training_blocks",
  {
    blockId: text("block_id").primaryKey(),
    profileId: text("profile_id")
      .notNull()
      .references(() => profile.profileId, {
        onUpdate: "cascade",
        onDelete: "restrict",
      }),
    goalType: text("goal_type")
      .$type<
        | "fat_loss"
        | "muscle_gain"
        | "strength"
        | "endurance"
        | "maintenance"
        | "general"
      >()
      .notNull(),
    primaryGoal: text("primary_goal").notNull(),
    trainingCycleSnapshot: text("training_cycle_snapshot").notNull(),
    startsOn: text("starts_on").notNull(),
    endsOn: text("ends_on"),
    changeReason: text("change_reason").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("idx_training_blocks_profile_dates").on(
      table.profileId,
      table.startsOn,
      table.endsOn,
    ),
    uniqueIndex("training_blocks_one_active_per_profile_uq")
      .on(table.profileId)
      .where(sql`${table.endsOn} IS NULL`),
    check(
      "training_blocks_goal_type_allowed",
      sql`${table.goalType} IN ('fat_loss', 'muscle_gain', 'strength', 'endurance', 'maintenance', 'general')`,
    ),
  ],
);

export const trainingScheduleEvents = sqliteTable(
  "training_schedule_events",
  {
    eventId: text("event_id").primaryKey(),
    profileId: text("profile_id")
      .notNull()
      .references(() => profile.profileId, {
        onUpdate: "cascade",
        onDelete: "restrict",
      }),
    effectiveDate: text("effective_date").notNull(),
    eventType: text("event_type").$type<"pause" | "resume">().notNull(),
    resumeOn: text("resume_on"),
    reason: text("reason"),
    recordedAt: text("recorded_at").notNull(),
    createdBy: text("created_by").notNull(),
    voidedAt: text("voided_at"),
    voidReason: text("void_reason"),
    voidedBy: text("voided_by"),
    createdAt: createdAt(),
  },
  (table) => [
    index("idx_training_schedule_events_profile_date").on(
      table.profileId,
      table.effectiveDate,
      table.recordedAt,
      table.eventId,
    ),
    check(
      "training_schedule_events_type_allowed",
      sql`${table.eventType} IN ('pause', 'resume')`,
    ),
    check(
      "training_schedule_events_resume_allowed",
      sql`(${table.eventType} = 'pause' AND (${table.resumeOn} IS NULL OR ${table.resumeOn} > ${table.effectiveDate})) OR (${table.eventType} = 'resume' AND ${table.resumeOn} IS NULL)`,
    ),
  ],
);

export const trainingExerciseSelections = sqliteTable(
  "training_exercise_selections",
  {
    selectionId: text("selection_id").primaryKey(),
    profileId: text("profile_id")
      .notNull()
      .references(() => profile.profileId, {
        onUpdate: "cascade",
        onDelete: "restrict",
      }),
    phaseId: text("phase_id").notNull(),
    slotId: text("slot_id").notNull(),
    scope: text("scope").$type<"date" | "venue">().notNull(),
    scopeValue: text("scope_value").notNull(),
    exercise: text("exercise").notNull(),
    overrideBatchId: text("override_batch_id"),
    prescriptionOverride: text("prescription_override"),
    loadGuidanceOverride: text("load_guidance_override"),
    effortOverride: text("effort_override"),
    recordedAt: text("recorded_at").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("idx_training_exercise_selections_lookup").on(
      table.profileId,
      table.phaseId,
      table.slotId,
      table.scope,
      table.scopeValue,
      table.recordedAt,
      table.selectionId,
    ),
    index("idx_training_exercise_selections_override_batch").on(
      table.overrideBatchId,
      table.selectionId,
    ),
    check(
      "training_exercise_selections_scope_allowed",
      sql`${table.scope} IN ('date', 'venue')`,
    ),
  ],
);

export const bodyMeasurements = sqliteTable(
  "body_measurements",
  {
    measurementId: text("measurement_id").primaryKey(),
    measuredAt: text("measured_at").notNull(),
    localDate: text("local_date"),
    sourceDevice: text("source_device").notNull(),
    sourceFile: text("source_file").notNull(),
    weightKg: real("weight_kg").notNull(),
    bmi: real("bmi"),
    bodyFatPct: real("body_fat_pct"),
    visceralFatRating: real("visceral_fat_rating"),
    muscleMassKg: real("muscle_mass_kg"),
    muscleQuality: real("muscle_quality"),
    boneMassKg: real("bone_mass_kg"),
    bmrKcalPerDay: integer("bmr_kcal_per_day"),
    metabolicAgeYears: integer("metabolic_age_years"),
    bodyWaterPct: real("body_water_pct"),
    physiqueRating: integer("physique_rating"),
    muscleMassRightArmKg: real("muscle_mass_right_arm_kg"),
    muscleMassLeftArmKg: real("muscle_mass_left_arm_kg"),
    muscleMassRightLegKg: real("muscle_mass_right_leg_kg"),
    muscleMassLeftLegKg: real("muscle_mass_left_leg_kg"),
    muscleMassTrunkKg: real("muscle_mass_trunk_kg"),
    muscleQualityRightArm: real("muscle_quality_right_arm"),
    muscleQualityLeftArm: real("muscle_quality_left_arm"),
    muscleQualityRightLeg: real("muscle_quality_right_leg"),
    muscleQualityLeftLeg: real("muscle_quality_left_leg"),
    muscleQualityTrunk: real("muscle_quality_trunk"),
    bodyFatRightArmPct: real("body_fat_right_arm_pct"),
    bodyFatLeftArmPct: real("body_fat_left_arm_pct"),
    bodyFatRightLegPct: real("body_fat_right_leg_pct"),
    bodyFatLeftLegPct: real("body_fat_left_leg_pct"),
    bodyFatTrunkPct: real("body_fat_trunk_pct"),
    heartRateBpm: real("heart_rate_bpm"),
    fatMassKg: real("fat_mass_kg"),
    estimatedFatFreeMassKg: real("estimated_fat_free_mass_kg"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("body_measurements_measured_at_uq").on(table.measuredAt),
    index("idx_body_measurements_measured_at").on(table.measuredAt),
    index("idx_body_measurements_local_date").on(
      table.localDate,
      table.measuredAt,
    ),
    check("body_measurements_weight_positive", sql`${table.weightKg} > 0`),
    check(
      "body_measurements_body_fat_range",
      sql`${table.bodyFatPct} IS NULL OR (${table.bodyFatPct} >= 0 AND ${table.bodyFatPct} <= 100)`,
    ),
    check(
      "body_measurements_water_range",
      sql`${table.bodyWaterPct} IS NULL OR (${table.bodyWaterPct} >= 0 AND ${table.bodyWaterPct} <= 100)`,
    ),
  ],
);

export const workoutSessions = sqliteTable(
  "workout_sessions",
  {
    sessionId: text("session_id").primaryKey(),
    source: text("source").notNull(),
    sessionIntent: text("session_intent")
      .$type<"normal" | "deload" | "test">()
      .notNull()
      .default("normal"),
    trainingBlockId: text("training_block_id").references(
      () => trainingBlocks.blockId,
      {
        onUpdate: "cascade",
        onDelete: "restrict",
      },
    ),
    trainingPhaseId: text("training_phase_id"),
    sessionTitle: text("session_title").notNull(),
    sessionType: text("session_type").notNull(),
    startedAt: text("started_at").notNull(),
    startedAtUtc: text("started_at_utc"),
    localDate: text("local_date"),
    endedAt: text("ended_at").notNull(),
    timePrecision: text("time_precision").notNull().default("exact"),
    durationSeconds: integer("duration_seconds").notNull(),
    totalSetsReported: integer("total_sets_reported").notNull().default(0),
    burnedCaloriesKcalReported: real("burned_calories_kcal_reported"),
    totalTvlKgReported: real("total_tvl_kg_reported"),
    effortRaw: text("effort_raw"),
    zone1Seconds: integer("zone_1_seconds"),
    zone2Seconds: integer("zone_2_seconds"),
    zone3Seconds: integer("zone_3_seconds"),
    zone4Seconds: integer("zone_4_seconds"),
    zone5Seconds: integer("zone_5_seconds"),
    venueManual: text("venue_manual"),
    shoulderPainPre010Manual: real("shoulder_pain_pre_0_10_manual"),
    shoulderPainPost010Manual: real("shoulder_pain_post_0_10_manual"),
    fatigueRpe010Manual: real("fatigue_rpe_0_10_manual"),
    notesManual: text("notes_manual"),
    activeCaloriesKcal: real("active_calories_kcal"),
    totalCaloriesKcal: real("total_calories_kcal"),
    elevationMetres: real("elevation_metres"),
    floorsClimbed: integer("floors_climbed"),
    averageRpm: real("average_rpm"),
    averageHeartRateBpm: real("average_heart_rate_bpm"),
    voidedAt: text("voided_at"),
    voidReason: text("void_reason"),
    voidedBy: text("voided_by"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("workout_sessions_started_at_utc_active_uq")
      .on(table.startedAtUtc)
      .where(sql`${table.voidedAt} IS NULL AND ${table.startedAtUtc} IS NOT NULL`),
    index("idx_workout_sessions_started_at").on(table.startedAt),
    index("idx_workout_sessions_local_date").on(table.localDate),
    index("idx_workout_sessions_type_started").on(
      table.sessionType,
      table.startedAt,
    ),
    check(
      "workout_sessions_duration_nonnegative",
      sql`${table.durationSeconds} >= 0`,
    ),
    check(
      "workout_sessions_sets_nonnegative",
      sql`${table.totalSetsReported} >= 0`,
    ),
    check(
      "workout_sessions_time_precision_allowed",
      sql`${table.timePrecision} IN ('minute', 'exact')`,
    ),
    check(
      "workout_sessions_intent_allowed",
      sql`${table.sessionIntent} IN ('normal', 'deload', 'test')`,
    ),
    check(
      "workout_sessions_shoulder_pain_pre_range",
      sql`${table.shoulderPainPre010Manual} IS NULL OR (${table.shoulderPainPre010Manual} >= 0 AND ${table.shoulderPainPre010Manual} <= 10)`,
    ),
    check(
      "workout_sessions_shoulder_pain_post_range",
      sql`${table.shoulderPainPost010Manual} IS NULL OR (${table.shoulderPainPost010Manual} >= 0 AND ${table.shoulderPainPost010Manual} <= 10)`,
    ),
    check(
      "workout_sessions_fatigue_range",
      sql`${table.fatigueRpe010Manual} IS NULL OR (${table.fatigueRpe010Manual} >= 0 AND ${table.fatigueRpe010Manual} <= 10)`,
    ),
  ],
);

export const workoutSets = sqliteTable(
  "workout_sets",
  {
    setId: text("set_id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => workoutSessions.sessionId, {
        onUpdate: "cascade",
        onDelete: "restrict",
      }),
    exercise: text("exercise").notNull(),
    setNoSession: integer("set_no_session").notNull(),
    setNoExercise: integer("set_no_exercise").notNull(),
    weightKgReported: real("weight_kg_reported"),
    reps: integer("reps"),
    timeSeconds: real("time_seconds"),
    distanceM: real("distance_m"),
    restSeconds: real("rest_seconds"),
    effortRaw: text("effort_raw"),
    primaryMuscleGroups: text("primary_muscle_groups"),
    sourceNote: text("source_note"),
    setTypeManual: text("set_type_manual"),
    loadBasisManual: text("load_basis_manual"),
    pain010Manual: real("pain_0_10_manual"),
    venueManual: text("venue_manual"),
    coachNote: text("coach_note"),
    sourceFile: text("source_file").notNull(),
    reportedLoadXRepsKg: real("reported_load_x_reps_kg"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("workout_sets_session_ordinal_uq").on(
      table.sessionId,
      table.setNoSession,
    ),
    index("idx_workout_sets_session").on(
      table.sessionId,
      table.setNoSession,
    ),
    index("idx_workout_sets_exercise").on(table.exercise, table.sessionId),
    check(
      "workout_sets_session_ordinal_positive",
      sql`${table.setNoSession} > 0`,
    ),
    check(
      "workout_sets_exercise_ordinal_positive",
      sql`${table.setNoExercise} > 0`,
    ),
    check(
      "workout_sets_reps_nonnegative",
      sql`${table.reps} IS NULL OR ${table.reps} >= 0`,
    ),
    check(
      "workout_sets_time_nonnegative",
      sql`${table.timeSeconds} IS NULL OR ${table.timeSeconds} >= 0`,
    ),
    check(
      "workout_sets_distance_nonnegative",
      sql`${table.distanceM} IS NULL OR ${table.distanceM} >= 0`,
    ),
    check(
      "workout_sets_pain_range",
      sql`${table.pain010Manual} IS NULL OR (${table.pain010Manual} >= 0 AND ${table.pain010Manual} <= 10)`,
    ),
  ],
);

export const trainingNextCourseOverrides = sqliteTable(
  "training_next_course_overrides",
  {
    overrideId: text("override_id").primaryKey(),
    overrideBatchId: text("override_batch_id").notNull(),
    profileId: text("profile_id")
      .notNull()
      .references(() => profile.profileId, {
        onUpdate: "cascade",
        onDelete: "restrict",
      }),
    trainingBlockId: text("training_block_id")
      .notNull()
      .references(() => trainingBlocks.blockId, {
        onUpdate: "cascade",
        onDelete: "restrict",
      }),
    phaseId: text("phase_id").notNull(),
    slotId: text("slot_id").notNull(),
    exercise: text("exercise").notNull(),
    prescriptionOverride: text("prescription_override").notNull(),
    loadGuidanceOverride: text("load_guidance_override").notNull(),
    effortOverride: text("effort_override").notNull(),
    sourceSessionId: text("source_session_id").references(
      () => workoutSessions.sessionId,
      {
        onUpdate: "cascade",
        onDelete: "restrict",
      },
    ),
    recordedAt: text("recorded_at").notNull(),
    createdBy: text("created_by").notNull(),
    consumedBySessionId: text("consumed_by_session_id").references(
      () => workoutSessions.sessionId,
      {
        onUpdate: "cascade",
        onDelete: "restrict",
      },
    ),
    consumedAt: text("consumed_at"),
    voidedAt: text("voided_at"),
    createdAt: createdAt(),
  },
  (table) => [
    index("idx_training_next_course_pending").on(
      table.profileId,
      table.trainingBlockId,
      table.phaseId,
      table.consumedAt,
      table.voidedAt,
      table.recordedAt,
    ),
    index("idx_training_next_course_batch").on(
      table.overrideBatchId,
      table.overrideId,
    ),
  ],
);

export const trainingPlannedSessions = sqliteTable(
  "training_planned_sessions",
  {
    planId: text("plan_id").primaryKey(),
    overrideBatchId: text("override_batch_id").notNull(),
    profileId: text("profile_id")
      .notNull()
      .references(() => profile.profileId, {
        onUpdate: "cascade",
        onDelete: "restrict",
      }),
    trainingBlockId: text("training_block_id")
      .notNull()
      .references(() => trainingBlocks.blockId, {
        onUpdate: "cascade",
        onDelete: "restrict",
      }),
    phaseId: text("phase_id").notNull(),
    localDate: text("local_date").notNull(),
    sessionIntent: text("session_intent")
      .$type<"deload" | "test">()
      .notNull(),
    recordedAt: text("recorded_at").notNull(),
    createdBy: text("created_by").notNull(),
    consumedBySessionId: text("consumed_by_session_id").references(
      () => workoutSessions.sessionId,
      {
        onUpdate: "cascade",
        onDelete: "restrict",
      },
    ),
    consumedAt: text("consumed_at"),
    voidedAt: text("voided_at"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("training_planned_sessions_batch_uq").on(
      table.overrideBatchId,
    ),
    index("idx_training_planned_sessions_pending").on(
      table.profileId,
      table.trainingBlockId,
      table.phaseId,
      table.localDate,
      table.consumedAt,
      table.voidedAt,
      table.recordedAt,
    ),
    check(
      "training_planned_sessions_intent_allowed",
      sql`${table.sessionIntent} IN ('deload', 'test')`,
    ),
  ],
);

export const sessionNotes = sqliteTable(
  "session_notes",
  {
    noteId: text("note_id").primaryKey(),
    noteDate: text("note_date").notNull(),
    sessionId: text("session_id").references(() => workoutSessions.sessionId, {
      onUpdate: "cascade",
      onDelete: "restrict",
    }),
    venue: text("venue"),
    exerciseOrArea: text("exercise_or_area"),
    noteType: text("note_type").notNull(),
    pain010: real("pain_0_10"),
    note: text("note").notNull(),
    source: text("source").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("idx_session_notes_date").on(table.noteDate),
    index("idx_session_notes_session").on(table.sessionId),
    check(
      "session_notes_pain_range",
      sql`${table.pain010} IS NULL OR (${table.pain010} >= 0 AND ${table.pain010} <= 10)`,
    ),
  ],
);

export const exerciseAliases = sqliteTable("exercise_aliases", {
  sourceExerciseName: text("source_exercise_name").primaryKey(),
  canonicalName: text("canonical_name").notNull(),
  primaryMuscleGroups: text("primary_muscle_groups"),
  loadBasis: text("load_basis"),
  comparisonScope: text("comparison_scope"),
  notes: text("notes"),
  source: text("source"),
});

export const corrections = sqliteTable(
  "corrections",
  {
    correctionId: text("correction_id").primaryKey(),
    effectiveDate: text("effective_date").notNull(),
    targetScope: text("target_scope").notNull(),
    targetKey: text("target_key").notNull(),
    fieldName: text("field_name").notNull(),
    originalValue: text("original_value"),
    correctedValue: text("corrected_value"),
    reason: text("reason").notNull(),
    source: text("source").notNull(),
    recordedAt: text("recorded_at").notNull(),
  },
  (table) => [
    uniqueIndex("corrections_natural_key_uq").on(
      table.targetScope,
      table.targetKey,
      table.fieldName,
      table.recordedAt,
    ),
    index("idx_corrections_target").on(
      table.targetScope,
      table.targetKey,
      table.fieldName,
    ),
  ],
);

export const operatingConstraints = sqliteTable("operating_constraints", {
  constraintId: text("constraint_id").primaryKey(),
  item: text("item").notNull().unique(),
  status: text("status").notNull(),
  operatingRule: text("operating_rule").notNull(),
  effectiveDate: text("effective_date").notNull(),
  source: text("source").notNull(),
});

export const evidenceBase = sqliteTable("evidence_base", {
  evidenceId: text("evidence_id").primaryKey(),
  sourceType: text("source_type").notNull(),
  title: text("title").notNull(),
  publicationYear: integer("publication_year"),
  authority: text("authority").notNull(),
  intendedUse: text("intended_use").notNull(),
  authorityTier: text("authority_tier").notNull(),
  statusAtRecordedDate: text("status_at_recorded_date"),
  url: text("url").notNull(),
  notes: text("notes"),
});

export const decisionRules = sqliteTable("decision_rules", {
  ruleId: text("rule_id").primaryKey(),
  domain: text("domain").notNull(),
  operationalRule: text("operational_rule").notNull(),
  evidenceId: text("evidence_id").references(() => evidenceBase.evidenceId, {
    onUpdate: "cascade",
    onDelete: "restrict",
  }),
  strengthOrStatus: text("strength_or_status").notNull(),
  personalisationNote: text("personalisation_note").notNull(),
});

export const dataPolicies = sqliteTable("data_policies", {
  policyKey: text("policy_key").primaryKey(),
  policyValue: text("policy_value").notNull(),
  status: text("status").notNull(),
  rationale: text("rationale").notNull(),
  recordedAt: text("recorded_at").notNull(),
});

export const importLog = sqliteTable(
  "import_log",
  {
    importId: text("import_id").primaryKey(),
    source: text("source").notNull(),
    fileName: text("file_name").notNull(),
    importedAt: text("imported_at").notNull(),
    dataMaxTimestamp: text("data_max_timestamp"),
    sourceRowsOrRecords: integer("source_rows_or_records"),
    normalisedSessions: integer("normalised_sessions"),
    normalisedSets: integer("normalised_sets"),
    sha256: text("sha256").notNull(),
    status: text("status").notNull(),
    notes: text("notes").notNull(),
  },
  (table) => [uniqueIndex("import_log_sha256_uq").on(table.sha256)],
);

export const nutritionFoods = sqliteTable(
  "nutrition_foods",
  {
    foodId: text("food_id").primaryKey(),
    displayName: text("display_name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    brand: text("brand"),
    category: text("category"),
    defaultUnit: text("default_unit").notNull(),
    isActive: integer("is_active").notNull().default(1),
    source: text("source").notNull(),
    originalLabel: text("original_label"),
    currentVersionNo: integer("current_version_no").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("nutrition_foods_normalized_name_uq").on(table.normalizedName),
    index("idx_nutrition_foods_active_name").on(
      table.isActive,
      table.displayName,
    ),
    check(
      "nutrition_foods_active_boolean",
      sql`${table.isActive} IN (0, 1)`,
    ),
    check(
      "nutrition_foods_version_positive",
      sql`${table.currentVersionNo} > 0`,
    ),
  ],
);

export const nutritionFoodVersions = sqliteTable(
  "nutrition_food_versions",
  {
    foodVersionId: text("food_version_id").primaryKey(),
    foodId: text("food_id")
      .notNull()
      .references(() => nutritionFoods.foodId, {
        onUpdate: "cascade",
        onDelete: "restrict",
      }),
    versionNo: integer("version_no").notNull(),
    baseQuantity: real("base_quantity").notNull(),
    baseUnit: text("base_unit").notNull(),
    energyKcal: real("energy_kcal"),
    proteinG: real("protein_g"),
    totalFatG: real("total_fat_g"),
    saturatedFatG: real("saturated_fat_g"),
    transFatG: real("trans_fat_g"),
    carbsG: real("carbs_g"),
    sugarG: real("sugar_g"),
    fibreG: real("fibre_g"),
    sodiumMg: real("sodium_mg"),
    cholesterolMg: real("cholesterol_mg"),
    sourceNote: text("source_note"),
    effectiveFrom: text("effective_from").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("nutrition_food_versions_food_version_uq").on(
      table.foodId,
      table.versionNo,
    ),
    index("idx_nutrition_food_versions_food").on(
      table.foodId,
      table.versionNo,
    ),
    check(
      "nutrition_food_versions_version_positive",
      sql`${table.versionNo} > 0`,
    ),
    check(
      "nutrition_food_versions_base_quantity_positive",
      sql`${table.baseQuantity} > 0`,
    ),
  ],
);

export const nutritionFoodAliases = sqliteTable(
  "nutrition_food_aliases",
  {
    aliasId: text("alias_id").primaryKey(),
    foodId: text("food_id")
      .notNull()
      .references(() => nutritionFoods.foodId, {
        onUpdate: "cascade",
        onDelete: "restrict",
      }),
    alias: text("alias").notNull(),
    normalizedAlias: text("normalized_alias").notNull(),
    source: text("source").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("nutrition_food_aliases_normalized_uq").on(
      table.normalizedAlias,
    ),
    index("idx_nutrition_food_aliases_food").on(table.foodId),
  ],
);

export const nutritionCombos = sqliteTable(
  "nutrition_combos",
  {
    comboId: text("combo_id").primaryKey(),
    displayName: text("display_name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    isActive: integer("is_active").notNull().default(1),
    currentVersionNo: integer("current_version_no").notNull().default(1),
    source: text("source").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("nutrition_combos_normalized_name_uq").on(
      table.normalizedName,
    ),
    index("idx_nutrition_combos_active_name").on(
      table.isActive,
      table.displayName,
    ),
    check(
      "nutrition_combos_active_boolean",
      sql`${table.isActive} IN (0, 1)`,
    ),
    check(
      "nutrition_combos_version_positive",
      sql`${table.currentVersionNo} > 0`,
    ),
  ],
);

export const nutritionComboVersions = sqliteTable(
  "nutrition_combo_versions",
  {
    comboVersionId: text("combo_version_id").primaryKey(),
    comboId: text("combo_id")
      .notNull()
      .references(() => nutritionCombos.comboId, {
        onUpdate: "cascade",
        onDelete: "restrict",
      }),
    versionNo: integer("version_no").notNull(),
    displayNameSnapshot: text("display_name_snapshot").notNull(),
    defaultMealType: text("default_meal_type"),
    contextTag: text("context_tag"),
    revisionReason: text("revision_reason"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("nutrition_combo_versions_combo_version_uq").on(
      table.comboId,
      table.versionNo,
    ),
    index("idx_nutrition_combo_versions_combo").on(
      table.comboId,
      table.versionNo,
    ),
    check(
      "nutrition_combo_versions_version_positive",
      sql`${table.versionNo} > 0`,
    ),
    check(
      "nutrition_combo_versions_meal_type_allowed",
      sql`${table.defaultMealType} IS NULL OR ${table.defaultMealType} IN ('breakfast', 'lunch', 'dinner', 'snack', 'late_night', 'other')`,
    ),
    check(
      "nutrition_combo_versions_context_allowed",
      sql`${table.contextTag} IS NULL OR ${table.contextTag} IN ('post_workout')`,
    ),
  ],
);

export const nutritionComboItems = sqliteTable(
  "nutrition_combo_items",
  {
    comboItemId: text("combo_item_id").primaryKey(),
    comboVersionId: text("combo_version_id")
      .notNull()
      .references(() => nutritionComboVersions.comboVersionId, {
        onUpdate: "cascade",
        onDelete: "restrict",
      }),
    itemOrdinal: integer("item_ordinal").notNull(),
    foodId: text("food_id")
      .notNull()
      .references(() => nutritionFoods.foodId, {
        onUpdate: "cascade",
        onDelete: "restrict",
      }),
    foodVersionIdAtSave: text("food_version_id_at_save")
      .notNull()
      .references(() => nutritionFoodVersions.foodVersionId, {
        onUpdate: "cascade",
        onDelete: "restrict",
      }),
    defaultQuantity: real("default_quantity").notNull(),
    unitSnapshot: text("unit_snapshot").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("nutrition_combo_items_version_ordinal_uq").on(
      table.comboVersionId,
      table.itemOrdinal,
    ),
    uniqueIndex("nutrition_combo_items_version_food_uq").on(
      table.comboVersionId,
      table.foodId,
    ),
    index("idx_nutrition_combo_items_version").on(
      table.comboVersionId,
      table.itemOrdinal,
    ),
    index("idx_nutrition_combo_items_food").on(table.foodId),
    check(
      "nutrition_combo_items_ordinal_positive",
      sql`${table.itemOrdinal} > 0`,
    ),
    check(
      "nutrition_combo_items_quantity_positive",
      sql`${table.defaultQuantity} > 0`,
    ),
  ],
);

export const nutritionMeals = sqliteTable(
  "nutrition_meals",
  {
    mealId: text("meal_id").primaryKey(),
    localDate: text("local_date").notNull(),
    eatenAt: text("eaten_at"),
    timePrecision: text("time_precision").notNull().default("date_only"),
    mealType: text("meal_type").notNull(),
    contextTag: text("context_tag"),
    originalMealType: text("original_meal_type"),
    source: text("source").notNull(),
    confidence: text("confidence").notNull(),
    currentRevisionNo: integer("current_revision_no").notNull().default(1),
    voidedAt: text("voided_at"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_nutrition_meals_local_date").on(
      table.localDate,
      table.mealType,
    ),
    index("idx_nutrition_meals_eaten_at").on(table.eatenAt),
    check(
      "nutrition_meals_type_allowed",
      sql`${table.mealType} IN ('breakfast', 'lunch', 'dinner', 'snack', 'late_night', 'other')`,
    ),
    check(
      "nutrition_meals_time_precision_allowed",
      sql`${table.timePrecision} IN ('exact', 'inferred', 'date_only')`,
    ),
    check(
      "nutrition_meals_confidence_allowed",
      sql`${table.confidence} IN ('high', 'medium', 'low')`,
    ),
    check(
      "nutrition_meals_revision_positive",
      sql`${table.currentRevisionNo} > 0`,
    ),
  ],
);

export const nutritionMealRevisions = sqliteTable(
  "nutrition_meal_revisions",
  {
    mealRevisionId: text("meal_revision_id").primaryKey(),
    mealId: text("meal_id")
      .notNull()
      .references(() => nutritionMeals.mealId, {
        onUpdate: "cascade",
        onDelete: "restrict",
      }),
    revisionNo: integer("revision_no").notNull(),
    revisionReason: text("revision_reason"),
    originalText: text("original_text"),
    notes: text("notes"),
    energyKcal: real("energy_kcal"),
    proteinG: real("protein_g"),
    totalFatG: real("total_fat_g"),
    saturatedFatG: real("saturated_fat_g"),
    transFatG: real("trans_fat_g"),
    carbsG: real("carbs_g"),
    sugarG: real("sugar_g"),
    fibreG: real("fibre_g"),
    sodiumMg: real("sodium_mg"),
    cholesterolMg: real("cholesterol_mg"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("nutrition_meal_revisions_meal_revision_uq").on(
      table.mealId,
      table.revisionNo,
    ),
    index("idx_nutrition_meal_revisions_meal").on(
      table.mealId,
      table.revisionNo,
    ),
    check(
      "nutrition_meal_revisions_revision_positive",
      sql`${table.revisionNo} > 0`,
    ),
  ],
);

export const nutritionMealComboSources = sqliteTable(
  "nutrition_meal_combo_sources",
  {
    mealRevisionId: text("meal_revision_id")
      .primaryKey()
      .references(() => nutritionMealRevisions.mealRevisionId, {
        onUpdate: "cascade",
        onDelete: "restrict",
      }),
    comboVersionId: text("combo_version_id")
      .notNull()
      .references(() => nutritionComboVersions.comboVersionId, {
        onUpdate: "cascade",
        onDelete: "restrict",
      }),
    createdAt: createdAt(),
  },
  (table) => [
    index("idx_nutrition_meal_combo_sources_combo").on(
      table.comboVersionId,
    ),
  ],
);

export const nutritionMealItems = sqliteTable(
  "nutrition_meal_items",
  {
    mealItemId: text("meal_item_id").primaryKey(),
    mealRevisionId: text("meal_revision_id")
      .notNull()
      .references(() => nutritionMealRevisions.mealRevisionId, {
        onUpdate: "cascade",
        onDelete: "restrict",
      }),
    itemOrdinal: integer("item_ordinal").notNull(),
    foodId: text("food_id").references(() => nutritionFoods.foodId, {
      onUpdate: "cascade",
      onDelete: "restrict",
    }),
    foodVersionId: text("food_version_id").references(
      () => nutritionFoodVersions.foodVersionId,
      {
        onUpdate: "cascade",
        onDelete: "restrict",
      },
    ),
    itemNameSnapshot: text("item_name_snapshot").notNull(),
    quantity: real("quantity"),
    unit: text("unit"),
    energyKcal: real("energy_kcal"),
    proteinG: real("protein_g"),
    totalFatG: real("total_fat_g"),
    saturatedFatG: real("saturated_fat_g"),
    transFatG: real("trans_fat_g"),
    carbsG: real("carbs_g"),
    sugarG: real("sugar_g"),
    fibreG: real("fibre_g"),
    sodiumMg: real("sodium_mg"),
    cholesterolMg: real("cholesterol_mg"),
    assumption: text("assumption"),
    confidence: text("confidence").notNull(),
    sourceRow: integer("source_row"),
    dataQualityFlags: text("data_quality_flags"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("nutrition_meal_items_revision_ordinal_uq").on(
      table.mealRevisionId,
      table.itemOrdinal,
    ),
    index("idx_nutrition_meal_items_revision").on(
      table.mealRevisionId,
      table.itemOrdinal,
    ),
    index("idx_nutrition_meal_items_food").on(table.foodId),
    check(
      "nutrition_meal_items_ordinal_positive",
      sql`${table.itemOrdinal} > 0`,
    ),
    check(
      "nutrition_meal_items_confidence_allowed",
      sql`${table.confidence} IN ('high', 'medium', 'low')`,
    ),
  ],
);

export const nutritionMealPlans = sqliteTable(
  "nutrition_meal_plans",
  {
    planId: text("plan_id").primaryKey(),
    scheduledDate: text("scheduled_date"),
    mealType: text("meal_type").notNull(),
    contextTag: text("context_tag"),
    originalMealType: text("original_meal_type"),
    source: text("source").notNull(),
    confidence: text("confidence").notNull(),
    originalText: text("original_text"),
    status: text("status").notNull().default("pending"),
    currentVersionNo: integer("current_version_no").notNull().default(1),
    completedMealId: text("completed_meal_id").references(
      () => nutritionMeals.mealId,
      {
        onUpdate: "cascade",
        onDelete: "restrict",
      },
    ),
    consumedAt: text("consumed_at"),
    cancelledAt: text("cancelled_at"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_nutrition_meal_plans_status_date").on(
      table.status,
      table.scheduledDate,
      table.createdAt,
    ),
    index("idx_nutrition_meal_plans_completed_meal").on(
      table.completedMealId,
    ),
    check(
      "nutrition_meal_plans_type_allowed",
      sql`${table.mealType} IN ('breakfast', 'lunch', 'dinner', 'snack', 'late_night', 'other')`,
    ),
    check(
      "nutrition_meal_plans_context_allowed",
      sql`${table.contextTag} IS NULL OR ${table.contextTag} IN ('post_workout')`,
    ),
    check(
      "nutrition_meal_plans_confidence_allowed",
      sql`${table.confidence} IN ('high', 'medium', 'low')`,
    ),
    check(
      "nutrition_meal_plans_status_allowed",
      sql`${table.status} IN ('pending', 'consumed', 'cancelled')`,
    ),
    check(
      "nutrition_meal_plans_version_positive",
      sql`${table.currentVersionNo} > 0`,
    ),
  ],
);

export const nutritionMealPlanItems = sqliteTable(
  "nutrition_meal_plan_items",
  {
    planItemId: text("plan_item_id").primaryKey(),
    planId: text("plan_id")
      .notNull()
      .references(() => nutritionMealPlans.planId, {
        onUpdate: "cascade",
        onDelete: "restrict",
      }),
    itemOrdinal: integer("item_ordinal").notNull(),
    foodId: text("food_id").references(() => nutritionFoods.foodId, {
      onUpdate: "cascade",
      onDelete: "restrict",
    }),
    foodVersionId: text("food_version_id").references(
      () => nutritionFoodVersions.foodVersionId,
      {
        onUpdate: "cascade",
        onDelete: "restrict",
      },
    ),
    itemNameSnapshot: text("item_name_snapshot").notNull(),
    quantity: real("quantity").notNull(),
    unit: text("unit").notNull(),
    energyKcal: real("energy_kcal"),
    proteinG: real("protein_g"),
    totalFatG: real("total_fat_g"),
    saturatedFatG: real("saturated_fat_g"),
    transFatG: real("trans_fat_g"),
    carbsG: real("carbs_g"),
    sugarG: real("sugar_g"),
    fibreG: real("fibre_g"),
    sodiumMg: real("sodium_mg"),
    cholesterolMg: real("cholesterol_mg"),
    assumption: text("assumption"),
    confidence: text("confidence").notNull(),
    dataQualityFlags: text("data_quality_flags"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("nutrition_meal_plan_items_plan_ordinal_uq").on(
      table.planId,
      table.itemOrdinal,
    ),
    index("idx_nutrition_meal_plan_items_plan").on(
      table.planId,
      table.itemOrdinal,
    ),
    index("idx_nutrition_meal_plan_items_food").on(table.foodId),
    check(
      "nutrition_meal_plan_items_ordinal_positive",
      sql`${table.itemOrdinal} > 0`,
    ),
    check(
      "nutrition_meal_plan_items_quantity_positive",
      sql`${table.quantity} > 0`,
    ),
    check(
      "nutrition_meal_plan_items_confidence_allowed",
      sql`${table.confidence} IN ('high', 'medium', 'low')`,
    ),
  ],
);

export const nutritionEnergyObservations = sqliteTable(
  "nutrition_energy_observations",
  {
    energyObservationId: text("energy_observation_id").primaryKey(),
    localDate: text("local_date").notNull(),
    observedAt: text("observed_at"),
    activeEnergyKcal: real("active_energy_kcal").notNull(),
    basalEnergyKcal: real("basal_energy_kcal"),
    status: text("status").notNull(),
    source: text("source").notNull(),
    note: text("note"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("idx_nutrition_energy_date_observed").on(
      table.localDate,
      table.observedAt,
      table.createdAt,
    ),
    check(
      "nutrition_energy_active_nonnegative",
      sql`${table.activeEnergyKcal} >= 0`,
    ),
    check(
      "nutrition_energy_basal_nonnegative",
      sql`${table.basalEnergyKcal} IS NULL OR ${table.basalEnergyKcal} >= 0`,
    ),
    check(
      "nutrition_energy_status_allowed",
      sql`${table.status} IN ('provisional', 'final')`,
    ),
  ],
);

export const nutritionSettings = sqliteTable(
  "nutrition_settings",
  {
    settingsId: text("settings_id").primaryKey(),
    effectiveFrom: text("effective_from").notNull(),
    status: text("status").notNull(),
    calorieTargetKcal: real("calorie_target_kcal"),
    dailyDeficitKcal: real("daily_deficit_kcal").notNull(),
    activeEnergyCreditRate: real("active_energy_credit_rate")
      .notNull()
      .default(0.8),
    proteinTargetG: real("protein_target_g").notNull(),
    saturatedFatLimitG: real("saturated_fat_limit_g"),
    sodiumLimitMg: real("sodium_limit_mg"),
    sourceNote: text("source_note").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("idx_nutrition_settings_effective").on(table.effectiveFrom),
    check(
      "nutrition_settings_status_allowed",
      sql`${table.status} IN ('provisional', 'active', 'retired')`,
    ),
    check(
      "nutrition_settings_deficit_nonnegative",
      sql`${table.dailyDeficitKcal} >= 0`,
    ),
    check(
      "nutrition_settings_credit_rate_range",
      sql`${table.activeEnergyCreditRate} >= 0 AND ${table.activeEnergyCreditRate} <= 1`,
    ),
    check(
      "nutrition_settings_protein_positive",
      sql`${table.proteinTargetG} > 0`,
    ),
  ],
);

export const nutritionImportLog = sqliteTable(
  "nutrition_import_log",
  {
    importId: text("import_id").primaryKey(),
    source: text("source").notNull(),
    fileName: text("file_name").notNull(),
    sha256: text("sha256").notNull(),
    importedAt: text("imported_at").notNull(),
    foodCount: integer("food_count").notNull(),
    mealCount: integer("meal_count").notNull(),
    mealItemCount: integer("meal_item_count").notNull(),
    adjustmentCount: integer("adjustment_count").notNull(),
    energyObservationCount: integer("energy_observation_count").notNull(),
    notes: text("notes").notNull(),
  },
  (table) => [
    uniqueIndex("nutrition_import_log_sha256_uq").on(table.sha256),
  ],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    auditId: integer("audit_id").primaryKey({ autoIncrement: true }),
    requestId: text("request_id").notNull(),
    actor: text("actor").notNull(),
    operation: text("operation").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    payloadSha256: text("payload_sha256"),
    occurredAt: text("occurred_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("audit_log_request_entity_uq").on(
      table.requestId,
      table.entityType,
      table.entityId,
    ),
    index("idx_audit_log_occurred_at").on(table.occurredAt),
  ],
);
