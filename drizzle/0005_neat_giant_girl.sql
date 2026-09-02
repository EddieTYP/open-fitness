CREATE TABLE `nutrition_combo_items` (
	`combo_item_id` text PRIMARY KEY NOT NULL,
	`combo_version_id` text NOT NULL,
	`item_ordinal` integer NOT NULL,
	`food_id` text NOT NULL,
	`food_version_id_at_save` text NOT NULL,
	`default_quantity` real NOT NULL,
	`unit_snapshot` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`combo_version_id`) REFERENCES `nutrition_combo_versions`(`combo_version_id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`food_id`) REFERENCES `nutrition_foods`(`food_id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`food_version_id_at_save`) REFERENCES `nutrition_food_versions`(`food_version_id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "nutrition_combo_items_ordinal_positive" CHECK("nutrition_combo_items"."item_ordinal" > 0),
	CONSTRAINT "nutrition_combo_items_quantity_positive" CHECK("nutrition_combo_items"."default_quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nutrition_combo_items_version_ordinal_uq` ON `nutrition_combo_items` (`combo_version_id`,`item_ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `nutrition_combo_items_version_food_uq` ON `nutrition_combo_items` (`combo_version_id`,`food_id`);--> statement-breakpoint
CREATE INDEX `idx_nutrition_combo_items_version` ON `nutrition_combo_items` (`combo_version_id`,`item_ordinal`);--> statement-breakpoint
CREATE INDEX `idx_nutrition_combo_items_food` ON `nutrition_combo_items` (`food_id`);--> statement-breakpoint
CREATE TABLE `nutrition_combo_versions` (
	`combo_version_id` text PRIMARY KEY NOT NULL,
	`combo_id` text NOT NULL,
	`version_no` integer NOT NULL,
	`display_name_snapshot` text NOT NULL,
	`default_meal_type` text,
	`context_tag` text,
	`revision_reason` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`combo_id`) REFERENCES `nutrition_combos`(`combo_id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "nutrition_combo_versions_version_positive" CHECK("nutrition_combo_versions"."version_no" > 0),
	CONSTRAINT "nutrition_combo_versions_meal_type_allowed" CHECK("nutrition_combo_versions"."default_meal_type" IS NULL OR "nutrition_combo_versions"."default_meal_type" IN ('breakfast', 'lunch', 'dinner', 'snack', 'late_night', 'other')),
	CONSTRAINT "nutrition_combo_versions_context_allowed" CHECK("nutrition_combo_versions"."context_tag" IS NULL OR "nutrition_combo_versions"."context_tag" IN ('post_workout'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nutrition_combo_versions_combo_version_uq` ON `nutrition_combo_versions` (`combo_id`,`version_no`);--> statement-breakpoint
CREATE INDEX `idx_nutrition_combo_versions_combo` ON `nutrition_combo_versions` (`combo_id`,`version_no`);--> statement-breakpoint
CREATE TABLE `nutrition_combos` (
	`combo_id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`current_version_no` integer DEFAULT 1 NOT NULL,
	`source` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "nutrition_combos_active_boolean" CHECK("nutrition_combos"."is_active" IN (0, 1)),
	CONSTRAINT "nutrition_combos_version_positive" CHECK("nutrition_combos"."current_version_no" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nutrition_combos_normalized_name_uq` ON `nutrition_combos` (`normalized_name`);--> statement-breakpoint
CREATE INDEX `idx_nutrition_combos_active_name` ON `nutrition_combos` (`is_active`,`display_name`);--> statement-breakpoint
CREATE TABLE `nutrition_meal_combo_sources` (
	`meal_revision_id` text PRIMARY KEY NOT NULL,
	`combo_version_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`meal_revision_id`) REFERENCES `nutrition_meal_revisions`(`meal_revision_id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`combo_version_id`) REFERENCES `nutrition_combo_versions`(`combo_version_id`) ON UPDATE cascade ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_nutrition_meal_combo_sources_combo` ON `nutrition_meal_combo_sources` (`combo_version_id`);
