PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_source_lifecycle_events` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text,
	`observation_id` text,
	`event_type` text NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`details` text,
	`from_status` text,
	`to_status` text,
	`from_merged_into` text,
	`to_merged_into` text,
	`reason` text,
	`actor` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`observation_id`) REFERENCES `source_observations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`from_merged_into`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`to_merged_into`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "source_lifecycle_events_shape_check" CHECK(((`source_id` is not null and `entity_type` is null and `entity_id` is null) or (`source_id` is null and `entity_type` is not null and `entity_id` is not null)))
);
--> statement-breakpoint
INSERT INTO `__new_source_lifecycle_events` (
	`id`,
	`source_id`,
	`observation_id`,
	`event_type`,
	`from_status`,
	`to_status`,
	`from_merged_into`,
	`to_merged_into`,
	`reason`,
	`actor`,
	`created_at`
)
SELECT
	`id`,
	`source_id`,
	`observation_id`,
	`event_type`,
	`from_status`,
	`to_status`,
	`from_merged_into`,
	`to_merged_into`,
	`reason`,
	`actor`,
	`created_at`
FROM `source_lifecycle_events`;
--> statement-breakpoint
DROP TABLE `source_lifecycle_events`;
--> statement-breakpoint
ALTER TABLE `__new_source_lifecycle_events` RENAME TO `source_lifecycle_events`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
CREATE INDEX `source_lifecycle_events_source_idx` ON `source_lifecycle_events` (`source_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `source_lifecycle_events_entity_idx` ON `source_lifecycle_events` (`entity_type`,`entity_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `archive_stream_daily_usage` (
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`bytes_reserved` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `day`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "archive_stream_daily_usage_bytes_check" CHECK(`bytes_reserved` >= 0)
);
--> statement-breakpoint
CREATE TABLE `archive_stream_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`revision_id`) REFERENCES `file_revisions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `archive_stream_leases_user_idx` ON `archive_stream_leases` (`user_id`,`expires_at`);
--> statement-breakpoint
CREATE INDEX `archive_stream_leases_expires_idx` ON `archive_stream_leases` (`expires_at`);
