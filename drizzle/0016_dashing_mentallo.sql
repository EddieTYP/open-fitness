CREATE TABLE `training_planned_sessions` (
	`plan_id` text PRIMARY KEY NOT NULL,
	`override_batch_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`training_block_id` text NOT NULL,
	`phase_id` text NOT NULL,
	`local_date` text NOT NULL,
	`session_intent` text NOT NULL,
	`recorded_at` text NOT NULL,
	`created_by` text NOT NULL,
	`consumed_by_session_id` text,
	`consumed_at` text,
	`voided_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profile`(`profile_id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`training_block_id`) REFERENCES `training_blocks`(`block_id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`consumed_by_session_id`) REFERENCES `workout_sessions`(`session_id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "training_planned_sessions_intent_allowed" CHECK("training_planned_sessions"."session_intent" IN ('deload', 'test'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `training_planned_sessions_batch_uq` ON `training_planned_sessions` (`override_batch_id`);--> statement-breakpoint
CREATE INDEX `idx_training_planned_sessions_pending` ON `training_planned_sessions` (`profile_id`,`training_block_id`,`phase_id`,`local_date`,`consumed_at`,`voided_at`,`recorded_at`);