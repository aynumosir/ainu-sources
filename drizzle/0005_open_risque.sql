CREATE TABLE `source_observation_diffs` (
	`id` text PRIMARY KEY NOT NULL,
	`observation_id` text NOT NULL,
	`source_id` text,
	`diff_kind` text NOT NULL,
	`is_new_source` integer DEFAULT false NOT NULL,
	`base_content_hash` text,
	`result_content_hash` text,
	`changed_scalar_fields` text,
	`changed_collections` text,
	`has_conflicts` integer DEFAULT false NOT NULL,
	`diff` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`observation_id`) REFERENCES `source_observations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_obs_diffs_obs_kind_idx` ON `source_observation_diffs` (`observation_id`,`diff_kind`);--> statement-breakpoint
CREATE INDEX `source_obs_diffs_source_idx` ON `source_observation_diffs` (`source_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `source_observations_status_idx` ON `source_observations` (`status`,`created_at`);