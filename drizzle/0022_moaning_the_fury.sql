PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_file_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`source_file_id` text NOT NULL,
	`revision_no` integer NOT NULL,
	`blob_sha256` text,
	`original_filename` text NOT NULL,
	`declared_media_type` text NOT NULL,
	`artifact_kind` text NOT NULL,
	`page_count` integer,
	`page_start` integer,
	`page_end` integer,
	`access_state` text DEFAULT 'available' NOT NULL,
	`is_current` integer DEFAULT false NOT NULL,
	`submitted_by` text NOT NULL,
	`submitted_at` integer NOT NULL,
	FOREIGN KEY (`source_file_id`) REFERENCES `source_files`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`blob_sha256`) REFERENCES `archive_blobs`(`sha256`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`submitted_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "file_revisions_revision_no_check" CHECK("__new_file_revisions"."revision_no" > 0),
	CONSTRAINT "file_revisions_artifact_kind_check" CHECK("__new_file_revisions"."artifact_kind" in ('original', 'bbox', 'page_images', 'linearized')),
	CONSTRAINT "file_revisions_page_count_check" CHECK("__new_file_revisions"."page_count" is null or "__new_file_revisions"."page_count" > 0),
	CONSTRAINT "file_revisions_page_start_check" CHECK("__new_file_revisions"."page_start" is null or "__new_file_revisions"."page_start" > 0),
	CONSTRAINT "file_revisions_page_end_check" CHECK("__new_file_revisions"."page_end" is null or "__new_file_revisions"."page_end" > 0),
	CONSTRAINT "file_revisions_access_state_check" CHECK("__new_file_revisions"."access_state" in ('available', 'embargoed', 'takedown')),
	CONSTRAINT "file_revisions_page_range_check" CHECK(("__new_file_revisions"."page_start" is null and "__new_file_revisions"."page_end" is null) or ("__new_file_revisions"."page_start" is not null and "__new_file_revisions"."page_end" is not null and "__new_file_revisions"."page_end" >= "__new_file_revisions"."page_start"))
);
--> statement-breakpoint
INSERT INTO `__new_file_revisions`("id", "source_file_id", "revision_no", "blob_sha256", "original_filename", "declared_media_type", "artifact_kind", "page_count", "page_start", "page_end", "access_state", "is_current", "submitted_by", "submitted_at") SELECT "id", "source_file_id", "revision_no", "blob_sha256", "original_filename", "declared_media_type", "artifact_kind", "page_count", "page_start", "page_end", "access_state", "is_current", "submitted_by", "submitted_at" FROM `file_revisions`;--> statement-breakpoint
DROP TABLE `file_revisions`;--> statement-breakpoint
ALTER TABLE `__new_file_revisions` RENAME TO `file_revisions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `file_revisions_source_file_revision_idx` ON `file_revisions` (`source_file_id`,`revision_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `source_file_one_current_revision` ON `file_revisions` (`source_file_id`) WHERE "file_revisions"."is_current" = 1;--> statement-breakpoint
CREATE INDEX `file_revisions_blob` ON `file_revisions` (`blob_sha256`);--> statement-breakpoint
CREATE INDEX `file_revisions_current_idx` ON `file_revisions` (`is_current`);