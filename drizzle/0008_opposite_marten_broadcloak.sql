CREATE TABLE `training_schedule_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`effective_date` text NOT NULL,
	`event_type` text NOT NULL,
	`resume_on` text,
	`reason` text,
	`recorded_at` text NOT NULL,
	`created_by` text NOT NULL,
	`voided_at` text,
	`void_reason` text,
	`voided_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profile`(`profile_id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "training_schedule_events_type_allowed" CHECK("training_schedule_events"."event_type" IN ('pause', 'resume')),
	CONSTRAINT "training_schedule_events_resume_allowed" CHECK(("training_schedule_events"."event_type" = 'pause' AND ("training_schedule_events"."resume_on" IS NULL OR "training_schedule_events"."resume_on" > "training_schedule_events"."effective_date")) OR ("training_schedule_events"."event_type" = 'resume' AND "training_schedule_events"."resume_on" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `idx_training_schedule_events_profile_date` ON `training_schedule_events` (`profile_id`,`effective_date`,`recorded_at`,`event_id`);