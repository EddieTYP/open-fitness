export const OPEN_FITNESS_DATABASE_NAME = "Open Fitness";
export const OPEN_FITNESS_DEFAULT_TIMEZONE = "UTC";

export const LEGACY_EDWARD_FITNESS_DATABASE_NAME = "Edward Fitness Master";
export const LEGACY_EDWARD_FITNESS_TIMEZONE = "Asia/Hong_Kong";

// Compatibility exports for fixtures, integrations, and existing installations.
export const EDWARD_FITNESS_DATABASE_NAME =
  LEGACY_EDWARD_FITNESS_DATABASE_NAME;
export const EDWARD_FITNESS_TIMEZONE = LEGACY_EDWARD_FITNESS_TIMEZONE;

function isSupportedTimeZone(value) {
  if (typeof value !== "string" || value.trim() !== value || !value) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function isSupportedFitnessDatabaseIdentity(databaseName, timezone) {
  if (
    databaseName === LEGACY_EDWARD_FITNESS_DATABASE_NAME &&
    timezone === LEGACY_EDWARD_FITNESS_TIMEZONE
  ) {
    return true;
  }
  return (
    databaseName === OPEN_FITNESS_DATABASE_NAME &&
    isSupportedTimeZone(timezone)
  );
}

export const OPEN_FITNESS_TABLE_NAMES = [
  "audit_log",
  "body_measurements",
  "corrections",
  "data_policies",
  "decision_rules",
  "evidence_base",
  "exercise_aliases",
  "import_log",
  "nutrition_combo_items",
  "nutrition_combo_versions",
  "nutrition_combos",
  "nutrition_energy_observations",
  "nutrition_food_aliases",
  "nutrition_food_versions",
  "nutrition_foods",
  "nutrition_import_log",
  "nutrition_meal_combo_sources",
  "nutrition_meal_items",
  "nutrition_meal_plan_items",
  "nutrition_meal_plans",
  "nutrition_meal_revisions",
  "nutrition_meals",
  "nutrition_settings",
  "operating_constraints",
  "profile",
  "schema_metadata",
  "session_notes",
  "training_schedule_events",
  "training_blocks",
  "training_exercise_selections",
  "training_next_course_overrides",
  "training_planned_sessions",
  "workout_sessions",
  "workout_sets",
];

export const OPEN_FITNESS_COLUMN_SENTINELS = {
  body_measurements: [
    "measurement_id",
    "measured_at",
    "local_date",
    "source_device",
    "weight_kg",
    "created_at",
  ],
  audit_log: [
    "audit_id",
    "request_id",
    "actor",
    "operation",
    "entity_type",
    "entity_id",
    "occurred_at",
  ],
  nutrition_meals: [
    "meal_id",
    "local_date",
    "source",
    "current_revision_no",
    "voided_at",
    "created_by",
  ],
  nutrition_settings: [
    "settings_id",
    "effective_from",
    "status",
    "calorie_target_kcal",
    "protein_target_g",
    "created_at",
  ],
  profile: [
    "profile_id",
    "display_name",
    "primary_goal",
    "goal_type",
    "training_cycle",
    "training_cycle_config",
    "strength_progress_exercise",
    "setup_completed",
    "timezone",
    "preferred_locale",
    "updated_at",
  ],
  schema_metadata: [
    "schema_version",
    "database_name",
    "canonical_master",
    "timezone",
    "created_at",
    "source_workbook_sha256",
  ],
  training_schedule_events: [
    "event_id",
    "profile_id",
    "effective_date",
    "event_type",
    "resume_on",
    "recorded_at",
    "voided_at",
  ],
  training_blocks: [
    "block_id",
    "profile_id",
    "goal_type",
    "primary_goal",
    "training_cycle_snapshot",
    "starts_on",
    "ends_on",
    "change_reason",
    "created_by",
  ],
  training_exercise_selections: [
    "selection_id",
    "profile_id",
    "phase_id",
    "slot_id",
    "scope",
    "scope_value",
    "exercise",
    "override_batch_id",
    "prescription_override",
    "load_guidance_override",
    "effort_override",
    "recorded_at",
    "created_by",
  ],
  training_next_course_overrides: [
    "override_id",
    "override_batch_id",
    "profile_id",
    "training_block_id",
    "phase_id",
    "slot_id",
    "exercise",
    "consumed_by_session_id",
    "voided_at",
  ],
  training_planned_sessions: [
    "plan_id",
    "override_batch_id",
    "profile_id",
    "training_block_id",
    "phase_id",
    "local_date",
    "session_intent",
    "consumed_by_session_id",
    "voided_at",
  ],
  workout_sessions: [
    "session_id",
    "source",
    "session_intent",
    "training_block_id",
    "training_phase_id",
    "started_at",
    "duration_seconds",
    "voided_at",
    "created_at",
  ],
  workout_sets: [
    "set_id",
    "session_id",
    "exercise",
    "set_no_session",
    "source_file",
    "created_at",
  ],
};

export const EDWARD_FITNESS_TABLE_NAMES = OPEN_FITNESS_TABLE_NAMES;
export const EDWARD_FITNESS_COLUMN_SENTINELS =
  OPEN_FITNESS_COLUMN_SENTINELS;
