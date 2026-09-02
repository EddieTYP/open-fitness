PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_schema_metadata` (
	`schema_version` integer PRIMARY KEY NOT NULL,
	`database_name` text NOT NULL,
	`canonical_master` integer DEFAULT 1 NOT NULL,
	`timezone` text DEFAULT 'Asia/Hong_Kong' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`source_workbook_sha256` text DEFAULT '' NOT NULL,
	CONSTRAINT "schema_metadata_canonical_master_boolean" CHECK("__new_schema_metadata"."canonical_master" IN (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_schema_metadata`("schema_version", "database_name", "canonical_master", "timezone", "created_at", "source_workbook_sha256") SELECT "schema_version", "database_name", "canonical_master", "timezone", "created_at", "source_workbook_sha256" FROM `schema_metadata`;--> statement-breakpoint
DROP TABLE `schema_metadata`;--> statement-breakpoint
ALTER TABLE `__new_schema_metadata` RENAME TO `schema_metadata`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_workout_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`session_title` text NOT NULL,
	`session_type` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text NOT NULL,
	`duration_seconds` integer NOT NULL,
	`total_sets_reported` integer DEFAULT 0 NOT NULL,
	`burned_calories_kcal_reported` real,
	`total_tvl_kg_reported` real,
	`effort_raw` text,
	`zone_1_seconds` integer,
	`zone_2_seconds` integer,
	`zone_3_seconds` integer,
	`zone_4_seconds` integer,
	`zone_5_seconds` integer,
	`venue_manual` text,
	`shoulder_pain_pre_0_10_manual` real,
	`shoulder_pain_post_0_10_manual` real,
	`fatigue_rpe_0_10_manual` real,
	`notes_manual` text,
	`active_calories_kcal` real,
	`total_calories_kcal` real,
	`elevation_metres` real,
	`floors_climbed` integer,
	`average_rpm` real,
	`average_heart_rate_bpm` real,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "workout_sessions_duration_nonnegative" CHECK("__new_workout_sessions"."duration_seconds" >= 0),
	CONSTRAINT "workout_sessions_sets_nonnegative" CHECK("__new_workout_sessions"."total_sets_reported" >= 0),
	CONSTRAINT "workout_sessions_shoulder_pain_pre_range" CHECK("__new_workout_sessions"."shoulder_pain_pre_0_10_manual" IS NULL OR ("__new_workout_sessions"."shoulder_pain_pre_0_10_manual" >= 0 AND "__new_workout_sessions"."shoulder_pain_pre_0_10_manual" <= 10)),
	CONSTRAINT "workout_sessions_shoulder_pain_post_range" CHECK("__new_workout_sessions"."shoulder_pain_post_0_10_manual" IS NULL OR ("__new_workout_sessions"."shoulder_pain_post_0_10_manual" >= 0 AND "__new_workout_sessions"."shoulder_pain_post_0_10_manual" <= 10)),
	CONSTRAINT "workout_sessions_fatigue_range" CHECK("__new_workout_sessions"."fatigue_rpe_0_10_manual" IS NULL OR ("__new_workout_sessions"."fatigue_rpe_0_10_manual" >= 0 AND "__new_workout_sessions"."fatigue_rpe_0_10_manual" <= 10))
);
--> statement-breakpoint
INSERT INTO `__new_workout_sessions`("session_id", "source", "session_title", "session_type", "started_at", "ended_at", "duration_seconds", "total_sets_reported", "burned_calories_kcal_reported", "total_tvl_kg_reported", "effort_raw", "zone_1_seconds", "zone_2_seconds", "zone_3_seconds", "zone_4_seconds", "zone_5_seconds", "venue_manual", "shoulder_pain_pre_0_10_manual", "shoulder_pain_post_0_10_manual", "fatigue_rpe_0_10_manual", "notes_manual", "active_calories_kcal", "total_calories_kcal", "elevation_metres", "floors_climbed", "average_rpm", "average_heart_rate_bpm", "created_at") SELECT "session_id", "source", "session_title", "session_type", "started_at", "ended_at", "duration_seconds", "total_sets_reported", "burned_calories_kcal_reported", "total_tvl_kg_reported", "effort_raw", "zone_1_seconds", "zone_2_seconds", "zone_3_seconds", "zone_4_seconds", "zone_5_seconds", "venue_manual", "shoulder_pain_pre_0_10_manual", "shoulder_pain_post_0_10_manual", "fatigue_rpe_0_10_manual", "notes_manual", "active_calories_kcal", "total_calories_kcal", "elevation_metres", "floors_climbed", "average_rpm", "average_heart_rate_bpm", "created_at" FROM `workout_sessions`;--> statement-breakpoint
DROP TABLE `workout_sessions`;--> statement-breakpoint
ALTER TABLE `__new_workout_sessions` RENAME TO `workout_sessions`;--> statement-breakpoint
CREATE UNIQUE INDEX `workout_sessions_started_at_uq` ON `workout_sessions` (`started_at`);--> statement-breakpoint
CREATE INDEX `idx_workout_sessions_started_at` ON `workout_sessions` (`started_at`);--> statement-breakpoint
CREATE INDEX `idx_workout_sessions_type_started` ON `workout_sessions` (`session_type`,`started_at`);--> statement-breakpoint
CREATE TABLE `__new_workout_sets` (
	`set_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`exercise` text NOT NULL,
	`set_no_session` integer NOT NULL,
	`set_no_exercise` integer NOT NULL,
	`weight_kg_reported` real,
	`reps` integer,
	`time_seconds` real,
	`distance_m` real,
	`rest_seconds` real,
	`effort_raw` text,
	`primary_muscle_groups` text,
	`source_note` text,
	`set_type_manual` text,
	`load_basis_manual` text,
	`pain_0_10_manual` real,
	`venue_manual` text,
	`coach_note` text,
	`source_file` text NOT NULL,
	`reported_load_x_reps_kg` real,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `workout_sessions`(`session_id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "workout_sets_session_ordinal_positive" CHECK("__new_workout_sets"."set_no_session" > 0),
	CONSTRAINT "workout_sets_exercise_ordinal_positive" CHECK("__new_workout_sets"."set_no_exercise" > 0),
	CONSTRAINT "workout_sets_reps_nonnegative" CHECK("__new_workout_sets"."reps" IS NULL OR "__new_workout_sets"."reps" >= 0),
	CONSTRAINT "workout_sets_time_nonnegative" CHECK("__new_workout_sets"."time_seconds" IS NULL OR "__new_workout_sets"."time_seconds" >= 0),
	CONSTRAINT "workout_sets_distance_nonnegative" CHECK("__new_workout_sets"."distance_m" IS NULL OR "__new_workout_sets"."distance_m" >= 0),
	CONSTRAINT "workout_sets_pain_range" CHECK("__new_workout_sets"."pain_0_10_manual" IS NULL OR ("__new_workout_sets"."pain_0_10_manual" >= 0 AND "__new_workout_sets"."pain_0_10_manual" <= 10))
);
--> statement-breakpoint
INSERT INTO `__new_workout_sets`("set_id", "session_id", "exercise", "set_no_session", "set_no_exercise", "weight_kg_reported", "reps", "time_seconds", "distance_m", "rest_seconds", "effort_raw", "primary_muscle_groups", "source_note", "set_type_manual", "load_basis_manual", "pain_0_10_manual", "venue_manual", "coach_note", "source_file", "reported_load_x_reps_kg", "created_at") SELECT "set_id", "session_id", "exercise", "set_no_session", "set_no_exercise", "weight_kg_reported", "reps", "time_seconds", "distance_m", "rest_seconds", "effort_raw", "primary_muscle_groups", "source_note", "set_type_manual", "load_basis_manual", "pain_0_10_manual", "venue_manual", "coach_note", "source_file", "reported_load_x_reps_kg", "created_at" FROM `workout_sets`;--> statement-breakpoint
DROP TABLE `workout_sets`;--> statement-breakpoint
ALTER TABLE `__new_workout_sets` RENAME TO `workout_sets`;--> statement-breakpoint
CREATE UNIQUE INDEX `workout_sets_session_ordinal_uq` ON `workout_sets` (`session_id`,`set_no_session`);--> statement-breakpoint
CREATE INDEX `idx_workout_sets_session` ON `workout_sets` (`session_id`,`set_no_session`);--> statement-breakpoint
CREATE INDEX `idx_workout_sets_exercise` ON `workout_sets` (`exercise`,`session_id`);
--> statement-breakpoint
CREATE VIEW `v_session_volume_reconciliation` AS
SELECT
  s.session_id,
  s.started_at,
  s.session_title,
  s.total_sets_reported,
  COUNT(ws.set_id) AS imported_sets,
  s.total_tvl_kg_reported,
  COALESCE(SUM(ws.reported_load_x_reps_kg), 0) AS calculated_tvl_kg,
  COALESCE(SUM(ws.reported_load_x_reps_kg), 0)
    - COALESCE(s.total_tvl_kg_reported, 0) AS tvl_difference_kg
FROM workout_sessions s
LEFT JOIN workout_sets ws ON ws.session_id = s.session_id
GROUP BY s.session_id;
--> statement-breakpoint
CREATE VIEW `v_daily_training` AS
WITH dates AS (
  SELECT SUBSTR(started_at, 1, 10) AS activity_date FROM workout_sessions
  UNION
  SELECT effective_date FROM corrections
),
aggregated AS (
  SELECT
    SUBSTR(started_at, 1, 10) AS activity_date,
    SUM(CASE WHEN total_sets_reported > 0 THEN 1 ELSE 0 END)
      AS strength_sessions,
    SUM(CASE
      WHEN total_sets_reported = 0 AND session_type LIKE 'Cardio%'
      THEN 1 ELSE 0 END) AS recorded_cardio_sessions,
    SUM(CASE
      WHEN total_sets_reported = 0 AND session_type LIKE 'Cardio%'
      THEN duration_seconds / 60.0 ELSE 0 END) AS recorded_cardio_minutes
  FROM workout_sessions
  GROUP BY SUBSTR(started_at, 1, 10)
),
ranked_corrections AS (
  SELECT
    effective_date AS activity_date,
    field_name,
    corrected_value,
    reason,
    ROW_NUMBER() OVER (
      PARTITION BY target_scope, target_key, field_name
      ORDER BY recorded_at DESC, correction_id DESC
    ) AS correction_rank
  FROM corrections
  WHERE target_scope = 'calendar_day'
),
cardio_corrections AS (
  SELECT
    activity_date,
    MAX(CASE
      WHEN field_name = 'formal_cardio_performed' AND correction_rank = 1
      THEN corrected_value END) AS formal_cardio_performed,
    GROUP_CONCAT(
      CASE WHEN correction_rank = 1 THEN reason END,
      ' | '
    ) AS correction_notes
  FROM ranked_corrections
  GROUP BY activity_date
)
SELECT
  dates.activity_date,
  COALESCE(aggregated.strength_sessions, 0) AS strength_sessions,
  CASE
    WHEN LOWER(TRIM(COALESCE(
      cardio_corrections.formal_cardio_performed, ''
    ))) IN ('0', 'false', 'no', 'none') THEN 0
    ELSE COALESCE(aggregated.recorded_cardio_sessions, 0)
  END AS formal_cardio_sessions,
  CASE
    WHEN LOWER(TRIM(COALESCE(
      cardio_corrections.formal_cardio_performed, ''
    ))) IN ('0', 'false', 'no', 'none') THEN 0
    ELSE COALESCE(aggregated.recorded_cardio_minutes, 0)
  END AS formal_cardio_minutes,
  cardio_corrections.correction_notes
FROM dates
LEFT JOIN aggregated USING (activity_date)
LEFT JOIN cardio_corrections USING (activity_date);
--> statement-breakpoint
CREATE VIEW `v_body_weight_7d_trend` AS
WITH latest AS (
  SELECT SUBSTR(MAX(measured_at), 1, 10) AS latest_date
  FROM body_measurements
)
SELECT
  latest.latest_date,
  AVG(CASE
    WHEN SUBSTR(measured_at, 1, 10)
      BETWEEN DATE(latest.latest_date, '-6 days') AND latest.latest_date
    THEN weight_kg END) AS latest_7d_avg_weight_kg,
  AVG(CASE
    WHEN SUBSTR(measured_at, 1, 10)
      BETWEEN DATE(latest.latest_date, '-13 days')
        AND DATE(latest.latest_date, '-7 days')
    THEN weight_kg END) AS previous_7d_avg_weight_kg,
  AVG(CASE
    WHEN SUBSTR(measured_at, 1, 10)
      BETWEEN DATE(latest.latest_date, '-6 days') AND latest.latest_date
    THEN weight_kg END)
    -
  AVG(CASE
    WHEN SUBSTR(measured_at, 1, 10)
      BETWEEN DATE(latest.latest_date, '-13 days')
        AND DATE(latest.latest_date, '-7 days')
    THEN weight_kg END) AS change_kg,
  COUNT(CASE
    WHEN SUBSTR(measured_at, 1, 10)
      BETWEEN DATE(latest.latest_date, '-6 days') AND latest.latest_date
    THEN 1 END) AS latest_7d_measurements
FROM body_measurements, latest;
--> statement-breakpoint
CREATE VIEW `v_data_quality_checks` AS
SELECT 'orphan_workout_sets' AS check_name, COUNT(*) AS failed_rows
FROM workout_sets ws
LEFT JOIN workout_sessions s ON s.session_id = ws.session_id
WHERE s.session_id IS NULL
UNION ALL
SELECT 'orphan_session_notes', COUNT(*)
FROM session_notes n
LEFT JOIN workout_sessions s ON s.session_id = n.session_id
WHERE n.session_id IS NOT NULL AND s.session_id IS NULL
UNION ALL
SELECT 'session_set_count_mismatch', COUNT(*)
FROM v_session_volume_reconciliation
WHERE total_sets_reported <> imported_sets
UNION ALL
SELECT 'duplicate_measurement_timestamps',
  COUNT(*) - COUNT(DISTINCT measured_at)
FROM body_measurements
UNION ALL
SELECT 'duplicate_session_timestamps',
  COUNT(*) - COUNT(DISTINCT started_at)
FROM workout_sessions;
--> statement-breakpoint
CREATE VIEW `v_exercise_session_summary` AS
SELECT
  s.started_at,
  s.session_id,
  s.session_title,
  ws.exercise,
  COUNT(*) AS sets,
  SUM(ws.reps) AS total_reps,
  MAX(ws.weight_kg_reported) AS max_weight_kg_reported,
  SUM(ws.reported_load_x_reps_kg) AS reported_volume_kg
FROM workout_sets ws
JOIN workout_sessions s ON s.session_id = ws.session_id
GROUP BY s.session_id, ws.exercise;
--> statement-breakpoint
CREATE VIEW `v_latest_body_measurement` AS
SELECT *
FROM body_measurements
WHERE measured_at = (SELECT MAX(measured_at) FROM body_measurements);
--> statement-breakpoint
CREATE VIEW `v_latest_cardio_session` AS
SELECT s.*
FROM workout_sessions s
JOIN v_daily_training d
  ON d.activity_date = SUBSTR(s.started_at, 1, 10)
WHERE s.total_sets_reported = 0
  AND s.session_type LIKE 'Cardio%'
  AND d.formal_cardio_sessions > 0
  AND s.started_at = (
    SELECT MAX(s2.started_at)
    FROM workout_sessions s2
    JOIN v_daily_training d2
      ON d2.activity_date = SUBSTR(s2.started_at, 1, 10)
    WHERE s2.total_sets_reported = 0
      AND s2.session_type LIKE 'Cardio%'
      AND d2.formal_cardio_sessions > 0
  );
--> statement-breakpoint
CREATE VIEW `v_latest_strength_session` AS
SELECT *
FROM workout_sessions
WHERE total_sets_reported > 0
  AND started_at = (
    SELECT MAX(started_at)
    FROM workout_sessions
    WHERE total_sets_reported > 0
  );
--> statement-breakpoint
CREATE VIEW `v_source_anomalies` AS
SELECT
  'negative_rest_seconds' AS anomaly_name,
  COUNT(*) AS affected_rows,
  'Motra export values are preserved unchanged; exclude or null these values in rest-time analysis.' AS handling_note
FROM workout_sets
WHERE rest_seconds < 0
UNION ALL
SELECT
  'reported_tvl_definition_difference',
  COUNT(*),
  'Motra-reported TVL can use conventions that differ from simple reported weight × reps; use same-definition comparisons.'
FROM v_session_volume_reconciliation
WHERE ABS(tvl_difference_kg) > 0.0001;
--> statement-breakpoint
CREATE VIEW `v_training_28d_summary` AS
WITH known_dates AS (
  SELECT SUBSTR(MAX(measured_at), 1, 10) AS known_date
  FROM body_measurements
  UNION ALL
  SELECT SUBSTR(MAX(started_at), 1, 10)
  FROM workout_sessions
  UNION ALL
  SELECT MAX(effective_date)
  FROM corrections
),
latest AS (
  SELECT MAX(known_date) AS latest_date
  FROM known_dates
)
SELECT
  latest.latest_date,
  COALESCE(SUM(CASE
    WHEN daily.activity_date
      BETWEEN DATE(latest.latest_date, '-27 days') AND latest.latest_date
    THEN daily.strength_sessions ELSE 0 END), 0) AS strength_sessions,
  COALESCE(SUM(CASE
    WHEN daily.activity_date
      BETWEEN DATE(latest.latest_date, '-27 days') AND latest.latest_date
    THEN daily.formal_cardio_minutes ELSE 0 END), 0) AS cardio_minutes
FROM v_daily_training daily, latest;
