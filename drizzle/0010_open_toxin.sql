CREATE TABLE `training_exercise_selections` (
	`selection_id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`phase_id` text NOT NULL,
	`slot_id` text NOT NULL,
	`scope` text NOT NULL,
	`scope_value` text NOT NULL,
	`exercise` text NOT NULL,
	`recorded_at` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profile`(`profile_id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "training_exercise_selections_scope_allowed" CHECK("training_exercise_selections"."scope" IN ('date', 'venue'))
);
--> statement-breakpoint
CREATE INDEX `idx_training_exercise_selections_lookup` ON `training_exercise_selections` (`profile_id`,`phase_id`,`slot_id`,`scope`,`scope_value`,`recorded_at`,`selection_id`);