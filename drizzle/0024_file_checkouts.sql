CREATE TABLE `file_checkouts` (
	`id` text PRIMARY KEY NOT NULL,
	`source_file_id` text NOT NULL,
	`repo_id` text NOT NULL,
	`path` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text,
	FOREIGN KEY (`source_file_id`) REFERENCES `source_files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repo_id`) REFERENCES `archive_repositories`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_checkouts_repo_path_idx` ON `file_checkouts` (`repo_id`,`path`);--> statement-breakpoint
CREATE UNIQUE INDEX `file_checkouts_file_repo_idx` ON `file_checkouts` (`source_file_id`,`repo_id`);--> statement-breakpoint
CREATE INDEX `file_checkouts_repo` ON `file_checkouts` (`repo_id`);--> statement-breakpoint
INSERT INTO `file_checkouts` ("id", "source_file_id", "repo_id", "path", "created_at", "created_by")
SELECT
	lower(
		substr(hex(randomblob(4)), 1, 8) || '-' || substr(hex(randomblob(2)), 1, 4) || '-4' ||
		substr(hex(randomblob(2)), 2, 3) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) ||
		substr(hex(randomblob(2)), 2, 3) || '-' || substr(hex(randomblob(6)), 1, 12)
	),
	"id", "checkout_repo_id", "checkout_path", "created_at", "created_by"
FROM `source_files`
WHERE "checkout_repo_id" IS NOT NULL AND "checkout_path" IS NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_source_files` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`role` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "source_files_role_check" CHECK("__new_source_files"."role" in ('scan', 'epub', 'supplement', 'derivative'))
);
--> statement-breakpoint
INSERT INTO `__new_source_files`("id", "source_id", "role", "label", "sort_order", "created_at", "created_by") SELECT "id", "source_id", "role", coalesce("label", ''), "sort_order", "created_at", "created_by" FROM `source_files`;--> statement-breakpoint
DROP TABLE `source_files`;--> statement-breakpoint
ALTER TABLE `__new_source_files` RENAME TO `source_files`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `source_files_source` ON `source_files` (`source_id`);