CREATE TABLE `training_blocks` (
	`block_id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`goal_type` text NOT NULL,
	`primary_goal` text NOT NULL,
	`training_cycle_snapshot` text NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text,
	`change_reason` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profile`(`profile_id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "training_blocks_goal_type_allowed" CHECK("training_blocks"."goal_type" IN ('fat_loss', 'muscle_gain', 'strength', 'endurance', 'maintenance', 'general'))
);
--> statement-breakpoint
CREATE INDEX `idx_training_blocks_profile_dates` ON `training_blocks` (`profile_id`,`starts_on`,`ends_on`);--> statement-breakpoint
CREATE UNIQUE INDEX `training_blocks_one_active_per_profile_uq` ON `training_blocks` (`profile_id`) WHERE "training_blocks"."ends_on" IS NULL;--> statement-breakpoint
INSERT INTO `training_blocks` (
	`block_id`,
	`profile_id`,
	`goal_type`,
	`primary_goal`,
	`training_cycle_snapshot`,
	`starts_on`,
	`change_reason`,
	`created_by`
)
SELECT
	'TRAINING-BLOCK|' || `profile_id` || '|legacy',
	`profile_id`,
	COALESCE(`goal_type`, 'general'),
	`primary_goal`,
	COALESCE(`training_cycle_config`, '{"version":1,"phases":[]}'),
	COALESCE(
		(SELECT MIN(COALESCE(`local_date`, SUBSTR(`started_at`, 1, 10))) FROM `workout_sessions`),
		SUBSTR(`updated_at`, 1, 10)
	),
	'Legacy records',
	'system'
FROM `profile`;--> statement-breakpoint
CREATE TABLE `training_next_course_overrides` (
	`override_id` text PRIMARY KEY NOT NULL,
	`override_batch_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`training_block_id` text NOT NULL,
	`phase_id` text NOT NULL,
	`slot_id` text NOT NULL,
	`exercise` text NOT NULL,
	`prescription_override` text NOT NULL,
	`load_guidance_override` text NOT NULL,
	`effort_override` text NOT NULL,
	`source_session_id` text,
	`recorded_at` text NOT NULL,
	`created_by` text NOT NULL,
	`consumed_by_session_id` text,
	`consumed_at` text,
	`voided_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profile`(`profile_id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`training_block_id`) REFERENCES `training_blocks`(`block_id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`source_session_id`) REFERENCES `workout_sessions`(`session_id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`consumed_by_session_id`) REFERENCES `workout_sessions`(`session_id`) ON UPDATE cascade ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_training_next_course_pending` ON `training_next_course_overrides` (`profile_id`,`training_block_id`,`phase_id`,`consumed_at`,`voided_at`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `idx_training_next_course_batch` ON `training_next_course_overrides` (`override_batch_id`,`override_id`);--> statement-breakpoint
ALTER TABLE `workout_sessions`
ADD `session_intent` text NOT NULL DEFAULT 'normal'
CHECK (`session_intent` IN ('normal', 'deload', 'test'));--> statement-breakpoint
ALTER TABLE `workout_sessions`
ADD `training_block_id` text REFERENCES `training_blocks`(`block_id`)
ON UPDATE cascade ON DELETE restrict;--> statement-breakpoint
UPDATE `workout_sessions`
SET `training_block_id` = (
	SELECT `block_id`
	FROM `training_blocks`
	WHERE `training_blocks`.`profile_id` = (
		SELECT `profile_id` FROM `profile` LIMIT 1
	)
	AND `ends_on` IS NULL
	LIMIT 1
)
WHERE `training_block_id` IS NULL;
