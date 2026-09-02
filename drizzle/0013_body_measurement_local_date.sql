ALTER TABLE `body_measurements` ADD `local_date` text;--> statement-breakpoint
UPDATE `body_measurements`
SET `local_date` = substr(`measured_at`, 1, 10)
WHERE `local_date` IS NULL;--> statement-breakpoint
CREATE INDEX `idx_body_measurements_local_date`
ON `body_measurements` (`local_date`, `measured_at`);--> statement-breakpoint
CREATE TRIGGER `body_measurements_local_date_insert_guard`
BEFORE INSERT ON `body_measurements`
FOR EACH ROW
WHEN NEW.`local_date` IS NULL
  OR NEW.`local_date` NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  OR date(NEW.`local_date`, '+0 days') <> NEW.`local_date`
BEGIN
  SELECT RAISE(ABORT, 'BODY_MEASUREMENT_LOCAL_DATE_REQUIRED');
END;--> statement-breakpoint
CREATE TRIGGER `body_measurements_local_date_update_guard`
BEFORE UPDATE OF `local_date` ON `body_measurements`
FOR EACH ROW
WHEN NEW.`local_date` IS NULL
  OR NEW.`local_date` NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  OR date(NEW.`local_date`, '+0 days') <> NEW.`local_date`
BEGIN
  SELECT RAISE(ABORT, 'BODY_MEASUREMENT_LOCAL_DATE_REQUIRED');
END;--> statement-breakpoint
DROP VIEW `v_body_weight_7d_trend`;--> statement-breakpoint
CREATE VIEW `v_body_weight_7d_trend` AS
WITH latest AS (
  SELECT MAX(local_date) AS latest_date
  FROM body_measurements
)
SELECT
  latest.latest_date,
  AVG(CASE
    WHEN local_date
      BETWEEN DATE(latest.latest_date, '-6 days') AND latest.latest_date
    THEN weight_kg END) AS latest_7d_avg_weight_kg,
  AVG(CASE
    WHEN local_date
      BETWEEN DATE(latest.latest_date, '-13 days')
        AND DATE(latest.latest_date, '-7 days')
    THEN weight_kg END) AS previous_7d_avg_weight_kg,
  AVG(CASE
    WHEN local_date
      BETWEEN DATE(latest.latest_date, '-6 days') AND latest.latest_date
    THEN weight_kg END)
    -
  AVG(CASE
    WHEN local_date
      BETWEEN DATE(latest.latest_date, '-13 days')
        AND DATE(latest.latest_date, '-7 days')
    THEN weight_kg END) AS change_kg,
  COUNT(CASE
    WHEN local_date
      BETWEEN DATE(latest.latest_date, '-6 days') AND latest.latest_date
    THEN 1 END) AS latest_7d_measurements
FROM body_measurements, latest;--> statement-breakpoint
DROP VIEW `v_training_28d_summary`;--> statement-breakpoint
CREATE VIEW `v_training_28d_summary` AS
WITH known_dates AS (
  SELECT MAX(local_date) AS known_date
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
FROM v_daily_training daily, latest;
