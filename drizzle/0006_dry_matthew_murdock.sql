CREATE TABLE `nutrition_meal_plan_items` (
	`plan_item_id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`item_ordinal` integer NOT NULL,
	`food_id` text,
	`food_version_id` text,
	`item_name_snapshot` text NOT NULL,
	`quantity` real NOT NULL,
	`unit` text NOT NULL,
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
	`data_quality_flags` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `nutrition_meal_plans`(`plan_id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`food_id`) REFERENCES `nutrition_foods`(`food_id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`food_version_id`) REFERENCES `nutrition_food_versions`(`food_version_id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "nutrition_meal_plan_items_ordinal_positive" CHECK("nutrition_meal_plan_items"."item_ordinal" > 0),
	CONSTRAINT "nutrition_meal_plan_items_quantity_positive" CHECK("nutrition_meal_plan_items"."quantity" > 0),
	CONSTRAINT "nutrition_meal_plan_items_confidence_allowed" CHECK("nutrition_meal_plan_items"."confidence" IN ('high', 'medium', 'low'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nutrition_meal_plan_items_plan_ordinal_uq` ON `nutrition_meal_plan_items` (`plan_id`,`item_ordinal`);--> statement-breakpoint
CREATE INDEX `idx_nutrition_meal_plan_items_plan` ON `nutrition_meal_plan_items` (`plan_id`,`item_ordinal`);--> statement-breakpoint
CREATE INDEX `idx_nutrition_meal_plan_items_food` ON `nutrition_meal_plan_items` (`food_id`);--> statement-breakpoint
CREATE TABLE `nutrition_meal_plans` (
	`plan_id` text PRIMARY KEY NOT NULL,
	`scheduled_date` text,
	`meal_type` text NOT NULL,
	`context_tag` text,
	`original_meal_type` text,
	`source` text NOT NULL,
	`confidence` text NOT NULL,
	`original_text` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`current_version_no` integer DEFAULT 1 NOT NULL,
	`completed_meal_id` text,
	`consumed_at` text,
	`cancelled_at` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`completed_meal_id`) REFERENCES `nutrition_meals`(`meal_id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "nutrition_meal_plans_type_allowed" CHECK("nutrition_meal_plans"."meal_type" IN ('breakfast', 'lunch', 'dinner', 'snack', 'late_night', 'other')),
	CONSTRAINT "nutrition_meal_plans_context_allowed" CHECK("nutrition_meal_plans"."context_tag" IS NULL OR "nutrition_meal_plans"."context_tag" IN ('post_workout')),
	CONSTRAINT "nutrition_meal_plans_confidence_allowed" CHECK("nutrition_meal_plans"."confidence" IN ('high', 'medium', 'low')),
	CONSTRAINT "nutrition_meal_plans_status_allowed" CHECK("nutrition_meal_plans"."status" IN ('pending', 'consumed', 'cancelled')),
	CONSTRAINT "nutrition_meal_plans_version_positive" CHECK("nutrition_meal_plans"."current_version_no" > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_nutrition_meal_plans_status_date` ON `nutrition_meal_plans` (`status`,`scheduled_date`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_nutrition_meal_plans_completed_meal` ON `nutrition_meal_plans` (`completed_meal_id`);