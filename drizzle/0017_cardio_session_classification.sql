DROP VIEW `v_latest_strength_session`;--> statement-breakpoint
DROP VIEW `v_latest_cardio_session`;--> statement-breakpoint
DROP VIEW `v_daily_training`;--> statement-breakpoint

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
    SUM(CASE
      WHEN total_sets_reported > 0
        AND session_type NOT LIKE 'Cardio%'
      THEN 1 ELSE 0 END) AS strength_sessions,
    SUM(CASE
      WHEN session_type LIKE 'Cardio%'
      THEN 1 ELSE 0 END) AS recorded_cardio_sessions,
    SUM(CASE
      WHEN session_type LIKE 'Cardio%'
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

CREATE VIEW `v_latest_cardio_session` AS
SELECT s.*
FROM workout_sessions s
JOIN v_daily_training d ON d.activity_date = s.local_date
WHERE s.voided_at IS NULL
  AND s.session_type LIKE 'Cardio%'
  AND d.formal_cardio_sessions > 0
  AND s.started_at_utc = (
    SELECT MAX(s2.started_at_utc)
    FROM workout_sessions s2
    JOIN v_daily_training d2 ON d2.activity_date = s2.local_date
    WHERE s2.voided_at IS NULL
      AND s2.session_type LIKE 'Cardio%'
      AND d2.formal_cardio_sessions > 0
  );--> statement-breakpoint

CREATE VIEW `v_latest_strength_session` AS
SELECT *
FROM workout_sessions
WHERE voided_at IS NULL
  AND total_sets_reported > 0
  AND session_type NOT LIKE 'Cardio%'
  AND started_at_utc = (
    SELECT MAX(started_at_utc)
    FROM workout_sessions
    WHERE voided_at IS NULL
      AND total_sets_reported > 0
      AND session_type NOT LIKE 'Cardio%'
  );
