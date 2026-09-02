ALTER TABLE `training_exercise_selections` ADD `override_batch_id` text;--> statement-breakpoint
ALTER TABLE `training_exercise_selections` ADD `prescription_override` text;--> statement-breakpoint
ALTER TABLE `training_exercise_selections` ADD `load_guidance_override` text;--> statement-breakpoint
ALTER TABLE `training_exercise_selections` ADD `effort_override` text;--> statement-breakpoint
CREATE INDEX `idx_training_exercise_selections_override_batch` ON `training_exercise_selections` (`override_batch_id`,`selection_id`);
