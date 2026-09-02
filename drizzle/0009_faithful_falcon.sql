ALTER TABLE `profile` ADD `display_name` text;--> statement-breakpoint
ALTER TABLE `profile` ADD `goal_type` text;--> statement-breakpoint
ALTER TABLE `profile` ADD `training_cycle_config` text;--> statement-breakpoint
ALTER TABLE `profile` ADD `strength_progress_exercise` text;--> statement-breakpoint
ALTER TABLE `profile` ADD `setup_completed` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `profile`
SET `goal_type` = CASE
	WHEN lower(`primary_goal`) LIKE '%fat loss%'
		OR lower(`primary_goal`) LIKE '%weight loss%'
		OR lower(`primary_goal`) LIKE '%body fat%'
		OR lower(`primary_goal`) LIKE '%reduce fat%'
		OR `primary_goal` LIKE '%減脂%' THEN 'fat_loss'
	WHEN lower(`primary_goal`) LIKE '%muscle%'
		OR lower(`primary_goal`) LIKE '%hypertrophy%'
		OR `primary_goal` LIKE '%增肌%' THEN 'muscle_gain'
	WHEN lower(`primary_goal`) LIKE '%strength%'
		OR `primary_goal` LIKE '%力量%' THEN 'strength'
	WHEN lower(`primary_goal`) LIKE '%endurance%'
		OR lower(`primary_goal`) LIKE '%cardio%'
		OR `primary_goal` LIKE '%耐力%' THEN 'endurance'
	WHEN lower(`primary_goal`) LIKE '%maintain%'
		OR `primary_goal` LIKE '%維持%' THEN 'maintenance'
	ELSE 'general'
END,
	`setup_completed` = true;--> statement-breakpoint
ALTER TABLE `workout_sessions` ADD `training_phase_id` text;
