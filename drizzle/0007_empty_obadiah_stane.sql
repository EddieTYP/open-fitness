ALTER TABLE `workout_sessions` ADD `started_at_utc` text;--> statement-breakpoint
ALTER TABLE `workout_sessions` ADD `local_date` text;--> statement-breakpoint
ALTER TABLE `workout_sessions` ADD `time_precision` text DEFAULT 'exact' NOT NULL CHECK (`time_precision` IN ('minute', 'exact'));--> statement-breakpoint
ALTER TABLE `workout_sessions` ADD `voided_at` text;--> statement-breakpoint
ALTER TABLE `workout_sessions` ADD `void_reason` text;--> statement-breakpoint
ALTER TABLE `workout_sessions` ADD `voided_by` text;--> statement-breakpoint

DROP INDEX `workout_sessions_started_at_uq`;--> statement-breakpoint

UPDATE `workout_sessions`
SET
  `started_at_utc` = strftime('%Y-%m-%dT%H:%M:%fZ', `started_at`),
  `local_date` = strftime('%Y-%m-%d', `started_at`, '+8 hours'),
  `started_at` = strftime('%Y-%m-%dT%H:%M:%S', `started_at`, '+8 hours') || '+08:00',
  `ended_at` = strftime('%Y-%m-%dT%H:%M:%S', `ended_at`, '+8 hours') || '+08:00';--> statement-breakpoint

CREATE UNIQUE INDEX `workout_sessions_started_at_utc_active_uq`
ON `workout_sessions` (`started_at_utc`)
WHERE `voided_at` IS NULL AND `started_at_utc` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_workout_sessions_local_date`
ON `workout_sessions` (`local_date`);--> statement-breakpoint

CREATE TRIGGER `workout_sessions_require_canonical_insert`
BEFORE INSERT ON `workout_sessions`
WHEN NEW.`voided_at` IS NULL
  AND (NEW.`started_at_utc` IS NULL OR NEW.`local_date` IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'active workout requires canonical timestamps');
END;--> statement-breakpoint

CREATE TRIGGER `workout_sessions_require_canonical_update`
BEFORE UPDATE OF `voided_at`, `started_at_utc`, `local_date`
ON `workout_sessions`
WHEN NEW.`voided_at` IS NULL
  AND (NEW.`started_at_utc` IS NULL OR NEW.`local_date` IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'active workout requires canonical timestamps');
END;--> statement-breakpoint

DROP VIEW `v_source_anomalies`;--> statement-breakpoint
DROP VIEW `v_training_28d_summary`;--> statement-breakpoint
DROP VIEW `v_latest_strength_session`;--> statement-breakpoint
DROP VIEW `v_latest_cardio_session`;--> statement-breakpoint
DROP VIEW `v_exercise_session_summary`;--> statement-breakpoint
DROP VIEW `v_data_quality_checks`;--> statement-breakpoint
DROP VIEW `v_session_volume_reconciliation`;--> statement-breakpoint
DROP VIEW `v_daily_training`;--> statement-breakpoint

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
WHERE s.voided_at IS NULL
GROUP BY s.session_id;--> statement-breakpoint

CREATE VIEW `v_daily_training` AS
WITH dates AS (
  SELECT local_date AS activity_date
  FROM workout_sessions
  WHERE voided_at IS NULL
  UNION
  SELECT effective_date FROM corrections
),
aggregated AS (
  SELECT
    local_date AS activity_date,
    SUM(CASE WHEN total_sets_reported > 0 THEN 1 ELSE 0 END)
      AS strength_sessions,
    SUM(CASE
      WHEN total_sets_reported = 0 AND session_type LIKE 'Cardio%'
      THEN 1 ELSE 0 END) AS recorded_cardio_sessions,
    SUM(CASE
      WHEN total_sets_reported = 0 AND session_type LIKE 'Cardio%'
      THEN duration_seconds / 60.0 ELSE 0 END) AS recorded_cardio_minutes
  FROM workout_sessions
  WHERE voided_at IS NULL
  GROUP BY local_date
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
LEFT JOIN cardio_corrections USING (activity_date);--> statement-breakpoint

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
  COUNT(*) - COUNT(DISTINCT started_at_utc)
FROM workout_sessions
WHERE voided_at IS NULL;--> statement-breakpoint

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
WHERE s.voided_at IS NULL
GROUP BY s.session_id, ws.exercise;--> statement-breakpoint

CREATE VIEW `v_latest_cardio_session` AS
SELECT s.*
FROM workout_sessions s
JOIN v_daily_training d ON d.activity_date = s.local_date
WHERE s.voided_at IS NULL
  AND s.total_sets_reported = 0
  AND s.session_type LIKE 'Cardio%'
  AND d.formal_cardio_sessions > 0
  AND s.started_at_utc = (
    SELECT MAX(s2.started_at_utc)
    FROM workout_sessions s2
    JOIN v_daily_training d2 ON d2.activity_date = s2.local_date
    WHERE s2.voided_at IS NULL
      AND s2.total_sets_reported = 0
      AND s2.session_type LIKE 'Cardio%'
      AND d2.formal_cardio_sessions > 0
  );--> statement-breakpoint

CREATE VIEW `v_latest_strength_session` AS
SELECT *
FROM workout_sessions
WHERE voided_at IS NULL
  AND total_sets_reported > 0
  AND started_at_utc = (
    SELECT MAX(started_at_utc)
    FROM workout_sessions
    WHERE voided_at IS NULL AND total_sets_reported > 0
  );--> statement-breakpoint

CREATE VIEW `v_source_anomalies` AS
SELECT
  'negative_rest_seconds' AS anomaly_name,
  COUNT(*) AS affected_rows,
  'Motra export values are preserved unchanged; exclude or null these values in rest-time analysis.' AS handling_note
FROM workout_sets ws
JOIN workout_sessions s ON s.session_id = ws.session_id
WHERE s.voided_at IS NULL AND ws.rest_seconds < 0
UNION ALL
SELECT
  'reported_tvl_definition_difference',
  COUNT(*),
  'Motra-reported TVL can use conventions that differ from simple reported weight × reps; use same-definition comparisons.'
FROM v_session_volume_reconciliation
WHERE ABS(tvl_difference_kg) > 0.0001;--> statement-breakpoint

CREATE VIEW `v_training_28d_summary` AS
WITH known_dates AS (
  SELECT SUBSTR(MAX(measured_at), 1, 10) AS known_date
  FROM body_measurements
  UNION ALL
  SELECT MAX(local_date)
  FROM workout_sessions
  WHERE voided_at IS NULL
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
FROM v_daily_training daily, latest;--> statement-breakpoint
