CREATE TABLE `nutrition_energy_observations` (
	`energy_observation_id` text PRIMARY KEY NOT NULL,
	`local_date` text NOT NULL,
	`observed_at` text,
	`active_energy_kcal` real NOT NULL,
	`basal_energy_kcal` real,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`note` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "nutrition_energy_active_nonnegative" CHECK("nutrition_energy_observations"."active_energy_kcal" >= 0),
	CONSTRAINT "nutrition_energy_basal_nonnegative" CHECK("nutrition_energy_observations"."basal_energy_kcal" IS NULL OR "nutrition_energy_observations"."basal_energy_kcal" >= 0),
	CONSTRAINT "nutrition_energy_status_allowed" CHECK("nutrition_energy_observations"."status" IN ('provisional', 'final'))
);
--> statement-breakpoint
CREATE INDEX `idx_nutrition_energy_date_observed` ON `nutrition_energy_observations` (`local_date`,`observed_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `nutrition_food_aliases` (
	`alias_id` text PRIMARY KEY NOT NULL,
	`food_id` text NOT NULL,
	`alias` text NOT NULL,
	`normalized_alias` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`food_id`) REFERENCES `nutrition_foods`(`food_id`) ON UPDATE cascade ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nutrition_food_aliases_normalized_uq` ON `nutrition_food_aliases` (`normalized_alias`);--> statement-breakpoint
CREATE INDEX `idx_nutrition_food_aliases_food` ON `nutrition_food_aliases` (`food_id`);--> statement-breakpoint
CREATE TABLE `nutrition_food_versions` (
	`food_version_id` text PRIMARY KEY NOT NULL,
	`food_id` text NOT NULL,
	`version_no` integer NOT NULL,
	`base_quantity` real NOT NULL,
	`base_unit` text NOT NULL,
	`energy_kcal` real,
	`protein_g` real,
	`total_fat_g` real,
	`saturated_fat_g` real,
	`trans_fat_g` real,
	`carbs_g` real,
	`sugar_g` real,
	`fibre_g` real,
	`sodium_mg` real,
	`cholesterol_mg` real,
	`source_note` text,
	`effective_from` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`food_id`) REFERENCES `nutrition_foods`(`food_id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "nutrition_food_versions_version_positive" CHECK("nutrition_food_versions"."version_no" > 0),
	CONSTRAINT "nutrition_food_versions_base_quantity_positive" CHECK("nutrition_food_versions"."base_quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nutrition_food_versions_food_version_uq` ON `nutrition_food_versions` (`food_id`,`version_no`);--> statement-breakpoint
CREATE INDEX `idx_nutrition_food_versions_food` ON `nutrition_food_versions` (`food_id`,`version_no`);--> statement-breakpoint
CREATE TABLE `nutrition_foods` (
	`food_id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`brand` text,
	`category` text,
	`default_unit` text NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`source` text NOT NULL,
	`original_label` text,
	`current_version_no` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "nutrition_foods_active_boolean" CHECK("nutrition_foods"."is_active" IN (0, 1)),
	CONSTRAINT "nutrition_foods_version_positive" CHECK("nutrition_foods"."current_version_no" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nutrition_foods_normalized_name_uq` ON `nutrition_foods` (`normalized_name`);--> statement-breakpoint
CREATE INDEX `idx_nutrition_foods_active_name` ON `nutrition_foods` (`is_active`,`display_name`);--> statement-breakpoint
CREATE TABLE `nutrition_import_log` (
	`import_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`file_name` text NOT NULL,
	`sha256` text NOT NULL,
	`imported_at` text NOT NULL,
	`food_count` integer NOT NULL,
	`meal_count` integer NOT NULL,
	`meal_item_count` integer NOT NULL,
	`adjustment_count` integer NOT NULL,
	`energy_observation_count` integer NOT NULL,
	`notes` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nutrition_import_log_sha256_uq` ON `nutrition_import_log` (`sha256`);--> statement-breakpoint
CREATE TABLE `nutrition_meal_items` (
	`meal_item_id` text PRIMARY KEY NOT NULL,
	`meal_revision_id` text NOT NULL,
	`item_ordinal` integer NOT NULL,
	`food_id` text,
	`food_version_id` text,
	`item_name_snapshot` text NOT NULL,
	`quantity` real,
	`unit` text,
	`energy_kcal` real,
	`protein_g` real,
	`total_fat_g` real,
	`saturated_fat_g` real,
	`trans_fat_g` real,
	`carbs_g` real,
	`sugar_g` real,
	`fibre_g` real,
	`sodium_mg` real,
	`cholesterol_mg` real,
	`assumption` text,
	`confidence` text NOT NULL,
	`source_row` integer,
	`data_quality_flags` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`meal_revision_id`) REFERENCES `nutrition_meal_revisions`(`meal_revision_id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`food_id`) REFERENCES `nutrition_foods`(`food_id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`food_version_id`) REFERENCES `nutrition_food_versions`(`food_version_id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "nutrition_meal_items_ordinal_positive" CHECK("nutrition_meal_items"."item_ordinal" > 0),
	CONSTRAINT "nutrition_meal_items_confidence_allowed" CHECK("nutrition_meal_items"."confidence" IN ('high', 'medium', 'low'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nutrition_meal_items_revision_ordinal_uq` ON `nutrition_meal_items` (`meal_revision_id`,`item_ordinal`);--> statement-breakpoint
CREATE INDEX `idx_nutrition_meal_items_revision` ON `nutrition_meal_items` (`meal_revision_id`,`item_ordinal`);--> statement-breakpoint
CREATE INDEX `idx_nutrition_meal_items_food` ON `nutrition_meal_items` (`food_id`);--> statement-breakpoint
CREATE TABLE `nutrition_meal_revisions` (
	`meal_revision_id` text PRIMARY KEY NOT NULL,
	`meal_id` text NOT NULL,
	`revision_no` integer NOT NULL,
	`revision_reason` text,
	`original_text` text,
	`notes` text,
	`energy_kcal` real,
	`protein_g` real,
	`total_fat_g` real,
	`saturated_fat_g` real,
	`trans_fat_g` real,
	`carbs_g` real,
	`sugar_g` real,
	`fibre_g` real,
	`sodium_mg` real,
	`cholesterol_mg` real,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`meal_id`) REFERENCES `nutrition_meals`(`meal_id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "nutrition_meal_revisions_revision_positive" CHECK("nutrition_meal_revisions"."revision_no" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nutrition_meal_revisions_meal_revision_uq` ON `nutrition_meal_revisions` (`meal_id`,`revision_no`);--> statement-breakpoint
CREATE INDEX `idx_nutrition_meal_revisions_meal` ON `nutrition_meal_revisions` (`meal_id`,`revision_no`);--> statement-breakpoint
CREATE TABLE `nutrition_meals` (
	`meal_id` text PRIMARY KEY NOT NULL,
	`local_date` text NOT NULL,
	`eaten_at` text,
	`time_precision` text DEFAULT 'date_only' NOT NULL,
	`meal_type` text NOT NULL,
	`context_tag` text,
	`original_meal_type` text,
	`source` text NOT NULL,
	`confidence` text NOT NULL,
	`current_revision_no` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "nutrition_meals_type_allowed" CHECK("nutrition_meals"."meal_type" IN ('breakfast', 'lunch', 'dinner', 'snack', 'late_night', 'other')),
	CONSTRAINT "nutrition_meals_time_precision_allowed" CHECK("nutrition_meals"."time_precision" IN ('exact', 'inferred', 'date_only')),
	CONSTRAINT "nutrition_meals_confidence_allowed" CHECK("nutrition_meals"."confidence" IN ('high', 'medium', 'low')),
	CONSTRAINT "nutrition_meals_revision_positive" CHECK("nutrition_meals"."current_revision_no" > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_nutrition_meals_local_date` ON `nutrition_meals` (`local_date`,`meal_type`);--> statement-breakpoint
CREATE INDEX `idx_nutrition_meals_eaten_at` ON `nutrition_meals` (`eaten_at`);--> statement-breakpoint
CREATE TABLE `nutrition_settings` (
	`settings_id` text PRIMARY KEY NOT NULL,
	`effective_from` text NOT NULL,
	`status` text NOT NULL,
	`daily_deficit_kcal` real NOT NULL,
	`active_energy_credit_rate` real DEFAULT 0.8 NOT NULL,
	`protein_target_g` real NOT NULL,
	`saturated_fat_limit_g` real,
	`sodium_limit_mg` real,
	`source_note` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "nutrition_settings_status_allowed" CHECK("nutrition_settings"."status" IN ('provisional', 'active', 'retired')),
	CONSTRAINT "nutrition_settings_deficit_nonnegative" CHECK("nutrition_settings"."daily_deficit_kcal" >= 0),
	CONSTRAINT "nutrition_settings_credit_rate_range" CHECK("nutrition_settings"."active_energy_credit_rate" >= 0 AND "nutrition_settings"."active_energy_credit_rate" <= 1),
	CONSTRAINT "nutrition_settings_protein_positive" CHECK("nutrition_settings"."protein_target_g" > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_nutrition_settings_effective` ON `nutrition_settings` (`effective_from`);