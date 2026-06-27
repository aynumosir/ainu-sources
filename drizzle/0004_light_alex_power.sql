PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_source_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`user_id` text,
	`user_name` text,
	`summary` text,
	`action` text DEFAULT 'update' NOT NULL,
	`snapshot` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_source_revisions`("id", "source_id", "user_id", "user_name", "summary", "action", "snapshot", "created_at") SELECT "id", "source_id", "user_id", "user_name", "summary", "action", "snapshot", "created_at" FROM `source_revisions`;--> statement-breakpoint
DROP TABLE `source_revisions`;--> statement-breakpoint
ALTER TABLE `__new_source_revisions` RENAME TO `source_revisions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `source_revisions_source_idx` ON `source_revisions` (`source_id`);