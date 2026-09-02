CREATE TABLE `audit_log` (
	`audit_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` text NOT NULL,
	`actor` text NOT NULL,
	`operation` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`payload_sha256` text,
	`occurred_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_log_request_entity_uq` ON `audit_log` (`request_id`,`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_log_occurred_at` ON `audit_log` (`occurred_at`);--> statement-breakpoint
CREATE TABLE `body_measurements` (
	`measurement_id` text PRIMARY KEY NOT NULL,
	`measured_at` text NOT NULL,
	`source_device` text NOT NULL,
	`source_file` text NOT NULL,
	`weight_kg` real NOT NULL,
	`bmi` real,
	`body_fat_pct` real,
	`visceral_fat_rating` real,
	`muscle_mass_kg` real,
	`muscle_quality` real,
	`bone_mass_kg` real,
	`bmr_kcal_per_day` integer,
	`metabolic_age_years` integer,
	`body_water_pct` real,
	`physique_rating` integer,
	`muscle_mass_right_arm_kg` real,
	`muscle_mass_left_arm_kg` real,
	`muscle_mass_right_leg_kg` real,
	`muscle_mass_left_leg_kg` real,
	`muscle_mass_trunk_kg` real,
	`muscle_quality_right_arm` real,
	`muscle_quality_left_arm` real,
	`muscle_quality_right_leg` real,
	`muscle_quality_left_leg` real,
	`muscle_quality_trunk` real,
	`body_fat_right_arm_pct` real,
	`body_fat_left_arm_pct` real,
	`body_fat_right_leg_pct` real,
	`body_fat_left_leg_pct` real,
	`body_fat_trunk_pct` real,
	`heart_rate_bpm` real,
	`fat_mass_kg` real,
	`estimated_fat_free_mass_kg` real,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "body_measurements_weight_positive" CHECK("body_measurements"."weight_kg" > 0),
	CONSTRAINT "body_measurements_body_fat_range" CHECK("body_measurements"."body_fat_pct" IS NULL OR ("body_measurements"."body_fat_pct" >= 0 AND "body_measurements"."body_fat_pct" <= 100)),
	CONSTRAINT "body_measurements_water_range" CHECK("body_measurements"."body_water_pct" IS NULL OR ("body_measurements"."body_water_pct" >= 0 AND "body_measurements"."body_water_pct" <= 100))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `body_measurements_measured_at_uq` ON `body_measurements` (`measured_at`);--> statement-breakpoint
CREATE INDEX `idx_body_measurements_measured_at` ON `body_measurements` (`measured_at`);--> statement-breakpoint
CREATE TABLE `corrections` (
	`correction_id` text PRIMARY KEY NOT NULL,
	`effective_date` text NOT NULL,
	`target_scope` text NOT NULL,
	`target_key` text NOT NULL,
	`field_name` text NOT NULL,
	`original_value` text,
	`corrected_value` text,
	`reason` text NOT NULL,
	`source` text NOT NULL,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `corrections_natural_key_uq` ON `corrections` (`target_scope`,`target_key`,`field_name`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `idx_corrections_target` ON `corrections` (`target_scope`,`target_key`,`field_name`);--> statement-breakpoint
CREATE TABLE `data_policies` (
	`policy_key` text PRIMARY KEY NOT NULL,
	`policy_value` text NOT NULL,
	`status` text NOT NULL,
	`rationale` text NOT NULL,
	`recorded_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `decision_rules` (
	`rule_id` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL,
	`operational_rule` text NOT NULL,
	`evidence_id` text,
	`strength_or_status` text NOT NULL,
	`personalisation_note` text NOT NULL,
	FOREIGN KEY (`evidence_id`) REFERENCES `evidence_base`(`evidence_id`) ON UPDATE cascade ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `evidence_base` (
	`evidence_id` text PRIMARY KEY NOT NULL,
	`source_type` text NOT NULL,
	`title` text NOT NULL,
	`publication_year` integer,
	`authority` text NOT NULL,
	`intended_use` text NOT NULL,
	`authority_tier` text NOT NULL,
	`status_at_recorded_date` text,
	`url` text NOT NULL,
	`notes` text
);
--> statement-breakpoint
CREATE TABLE `exercise_aliases` (
	`source_exercise_name` text PRIMARY KEY NOT NULL,
	`canonical_name` text NOT NULL,
	`primary_muscle_groups` text,
	`load_basis` text,
	`comparison_scope` text,
	`notes` text,
	`source` text
);
--> statement-breakpoint
CREATE TABLE `import_log` (
	`import_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`file_name` text NOT NULL,
	`imported_at` text NOT NULL,
	`data_max_timestamp` text,
	`source_rows_or_records` integer,
	`normalised_sessions` integer,
	`normalised_sets` integer,
	`sha256` text NOT NULL,
	`status` text NOT NULL,
	`notes` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_log_sha256_uq` ON `import_log` (`sha256`);--> statement-breakpoint
CREATE TABLE `operating_constraints` (
	`constraint_id` text PRIMARY KEY NOT NULL,
	`item` text NOT NULL,
	`status` text NOT NULL,
	`operating_rule` text NOT NULL,
	`effective_date` text NOT NULL,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operating_constraints_item_unique` ON `operating_constraints` (`item`);--> statement-breakpoint
CREATE TABLE `profile` (
	`profile_id` text PRIMARY KEY NOT NULL,
	`primary_goal` text NOT NULL,
	`training_cycle` text NOT NULL,
	`height_cm` real,
	`timezone` text DEFAULT 'Asia/Hong_Kong' NOT NULL,
	`owner_email` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `schema_metadata` (
	`schema_version` integer PRIMARY KEY NOT NULL,
	`database_name` text NOT NULL,
	`canonical_master` integer DEFAULT 1 NOT NULL,
	`timezone` text DEFAULT 'Asia/Hong_Kong' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`source_workbook_sha256` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_notes` (
	`note_id` text PRIMARY KEY NOT NULL,
	`note_date` text NOT NULL,
	`session_id` text,
	`venue` text,
	`exercise_or_area` text,
	`note_type` text NOT NULL,
	`pain_0_10` real,
	`note` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `workout_sessions`(`session_id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "session_notes_pain_range" CHECK("session_notes"."pain_0_10" IS NULL OR ("session_notes"."pain_0_10" >= 0 AND "session_notes"."pain_0_10" <= 10))
);
--> statement-breakpoint
CREATE INDEX `idx_session_notes_date` ON `session_notes` (`note_date`);--> statement-breakpoint
CREATE INDEX `idx_session_notes_session` ON `session_notes` (`session_id`);--> statement-breakpoint
CREATE TABLE `workout_sessions` (
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
	CONSTRAINT "workout_sessions_duration_nonnegative" CHECK("workout_sessions"."duration_seconds" >= 0),
	CONSTRAINT "workout_sessions_sets_nonnegative" CHECK("workout_sessions"."total_sets_reported" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workout_sessions_started_at_uq` ON `workout_sessions` (`started_at`);--> statement-breakpoint
CREATE INDEX `idx_workout_sessions_started_at` ON `workout_sessions` (`started_at`);--> statement-breakpoint
CREATE INDEX `idx_workout_sessions_type_started` ON `workout_sessions` (`session_type`,`started_at`);--> statement-breakpoint
CREATE TABLE `workout_sets` (
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
	CONSTRAINT "workout_sets_session_ordinal_positive" CHECK("workout_sets"."set_no_session" > 0),
	CONSTRAINT "workout_sets_exercise_ordinal_positive" CHECK("workout_sets"."set_no_exercise" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workout_sets_session_ordinal_uq` ON `workout_sets` (`session_id`,`set_no_session`);--> statement-breakpoint
CREATE INDEX `idx_workout_sets_session` ON `workout_sets` (`session_id`,`set_no_session`);--> statement-breakpoint
CREATE INDEX `idx_workout_sets_exercise` ON `workout_sets` (`exercise`,`session_id`);