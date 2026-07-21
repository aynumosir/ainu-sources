CREATE TABLE `archive_content_api_daily_usage` (
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`use_kind` text NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`units` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `day`, `use_kind`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "archive_content_api_daily_usage_use_kind_check" CHECK("archive_content_api_daily_usage"."use_kind" in ('text', 'search')),
	CONSTRAINT "archive_content_api_daily_usage_calls_check" CHECK("archive_content_api_daily_usage"."calls" >= 0),
	CONSTRAINT "archive_content_api_daily_usage_units_check" CHECK("archive_content_api_daily_usage"."units" >= 0)
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_archive_stream_daily_usage` (
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`budget_kind` text DEFAULT 'download' NOT NULL,
	`bytes_reserved` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `day`, `budget_kind`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "archive_stream_daily_usage_budget_kind_check" CHECK("__new_archive_stream_daily_usage"."budget_kind" in ('download', 'view')),
	CONSTRAINT "archive_stream_daily_usage_bytes_check" CHECK("__new_archive_stream_daily_usage"."bytes_reserved" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_archive_stream_daily_usage`("user_id", "day", "budget_kind", "bytes_reserved", "updated_at") SELECT "user_id", "day", 'download', "bytes_reserved", "updated_at" FROM `archive_stream_daily_usage`;--> statement-breakpoint
DROP TABLE `archive_stream_daily_usage`;--> statement-breakpoint
ALTER TABLE `__new_archive_stream_daily_usage` RENAME TO `archive_stream_daily_usage`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
