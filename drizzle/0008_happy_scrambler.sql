CREATE TABLE `archive_blobs` (
	`sha256` text PRIMARY KEY NOT NULL,
	`bytes` integer NOT NULL,
	`detected_media_type` text NOT NULL,
	`r2_etag` text,
	`r2_version` text,
	`storage_state` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text,
	`verified_at` integer,
	`quarantine_review_deadline` integer,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "archive_blobs_sha256_check" CHECK(length("archive_blobs"."sha256") = 64 and "archive_blobs"."sha256" not glob '*[^0-9a-f]*'),
	CONSTRAINT "archive_blobs_bytes_check" CHECK("archive_blobs"."bytes" >= 0),
	CONSTRAINT "archive_blobs_storage_state_check" CHECK("archive_blobs"."storage_state" in ('verified', 'quarantined', 'deleted')),
	CONSTRAINT "archive_blobs_verified_state_check" CHECK(("archive_blobs"."storage_state" = 'verified' and "archive_blobs"."verified_at" is not null) or "archive_blobs"."storage_state" in ('quarantined', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE `archive_repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `archive_repositories_name_idx` ON `archive_repositories` (`name`);--> statement-breakpoint
CREATE TABLE `blob_origins` (
	`id` text PRIMARY KEY NOT NULL,
	`blob_sha256` text NOT NULL,
	`origin_kind` text NOT NULL,
	`lfs_oid` text,
	`git_blob_sha1` text,
	`repository` text,
	`historical_path` text,
	`pointer_bytes` integer,
	`first_commit` text,
	`last_commit` text,
	`note` text,
	FOREIGN KEY (`blob_sha256`) REFERENCES `archive_blobs`(`sha256`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "blob_origins_origin_kind_check" CHECK("blob_origins"."origin_kind" in ('lfs', 'git_blob', 'orphan')),
	CONSTRAINT "blob_origins_kind_consistency_check" CHECK(("blob_origins"."origin_kind" = 'lfs' and "blob_origins"."lfs_oid" is not null and "blob_origins"."git_blob_sha1" is null) or ("blob_origins"."origin_kind" = 'git_blob' and "blob_origins"."git_blob_sha1" is not null and "blob_origins"."lfs_oid" is null) or ("blob_origins"."origin_kind" = 'orphan' and "blob_origins"."lfs_oid" is null and "blob_origins"."git_blob_sha1" is null and "blob_origins"."note" is not null))
);
--> statement-breakpoint
CREATE TABLE `capability_tokens` (
	`jti` text PRIMARY KEY NOT NULL,
	`revision_id` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`max_bytes` integer NOT NULL,
	`bytes_served` integer DEFAULT 0 NOT NULL,
	`redeemed_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `file_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "capability_tokens_max_bytes_check" CHECK("capability_tokens"."max_bytes" > 0),
	CONSTRAINT "capability_tokens_bytes_served_check" CHECK("capability_tokens"."bytes_served" >= 0),
	CONSTRAINT "capability_tokens_bytes_limit_check" CHECK("capability_tokens"."bytes_served" <= "capability_tokens"."max_bytes")
);
--> statement-breakpoint
CREATE TABLE `file_revisions` (
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
	`review_status` text NOT NULL,
	`access_state` text DEFAULT 'available' NOT NULL,
	`is_current` integer DEFAULT false NOT NULL,
	`submitted_by` text NOT NULL,
	`submitted_at` integer NOT NULL,
	`reviewed_by` text,
	`reviewed_at` integer,
	`review_note` text,
	FOREIGN KEY (`source_file_id`) REFERENCES `source_files`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`blob_sha256`) REFERENCES `archive_blobs`(`sha256`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`submitted_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "file_revisions_revision_no_check" CHECK("file_revisions"."revision_no" > 0),
	CONSTRAINT "file_revisions_artifact_kind_check" CHECK("file_revisions"."artifact_kind" in ('original', 'bbox', 'page_images', 'linearized')),
	CONSTRAINT "file_revisions_page_count_check" CHECK("file_revisions"."page_count" is null or "file_revisions"."page_count" > 0),
	CONSTRAINT "file_revisions_page_start_check" CHECK("file_revisions"."page_start" is null or "file_revisions"."page_start" > 0),
	CONSTRAINT "file_revisions_page_end_check" CHECK("file_revisions"."page_end" is null or "file_revisions"."page_end" > 0),
	CONSTRAINT "file_revisions_review_status_check" CHECK("file_revisions"."review_status" in ('pending', 'approved', 'rejected', 'withdrawn', 'expunged')),
	CONSTRAINT "file_revisions_access_state_check" CHECK("file_revisions"."access_state" in ('available', 'embargoed', 'takedown')),
	CONSTRAINT "file_revisions_page_range_check" CHECK(("file_revisions"."page_start" is null and "file_revisions"."page_end" is null) or ("file_revisions"."page_start" is not null and "file_revisions"."page_end" is not null and "file_revisions"."page_end" >= "file_revisions"."page_start")),
	CONSTRAINT "file_revisions_review_pair_check" CHECK(("file_revisions"."reviewed_by" is null and "file_revisions"."reviewed_at" is null) or ("file_revisions"."reviewed_by" is not null and "file_revisions"."reviewed_at" is not null)),
	CONSTRAINT "file_revisions_current_review_status_check" CHECK("file_revisions"."is_current" = 0 or "file_revisions"."review_status" = 'approved'),
	CONSTRAINT "file_revisions_expunged_blob_check" CHECK(("file_revisions"."review_status" = 'expunged' and "file_revisions"."blob_sha256" is null and "file_revisions"."is_current" = 0) or ("file_revisions"."review_status" <> 'expunged' and "file_revisions"."blob_sha256" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_revisions_source_file_revision_idx` ON `file_revisions` (`source_file_id`,`revision_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `source_file_one_current_revision` ON `file_revisions` (`source_file_id`) WHERE "file_revisions"."is_current" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `source_file_one_pending_revision` ON `file_revisions` (`source_file_id`) WHERE "file_revisions"."review_status" = 'pending';--> statement-breakpoint
CREATE INDEX `file_revisions_blob` ON `file_revisions` (`blob_sha256`);--> statement-breakpoint
CREATE TABLE `revision_derivations` (
	`derived_revision_id` text NOT NULL,
	`parent_revision_id` text NOT NULL,
	`relation` text NOT NULL,
	`parameters_json` text,
	PRIMARY KEY(`derived_revision_id`, `parent_revision_id`, `relation`),
	FOREIGN KEY (`derived_revision_id`) REFERENCES `file_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`parent_revision_id`) REFERENCES `file_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "revision_derivations_distinct_check" CHECK("revision_derivations"."derived_revision_id" <> "revision_derivations"."parent_revision_id")
);
--> statement-breakpoint
CREATE TABLE `revision_ocr_coverage` (
	`revision_id` text NOT NULL,
	`variant` text NOT NULL,
	`status` text NOT NULL,
	`tool` text,
	`tool_version` text,
	`preferred` integer DEFAULT false NOT NULL,
	`measured_at` integer NOT NULL,
	PRIMARY KEY(`revision_id`, `variant`),
	FOREIGN KEY (`revision_id`) REFERENCES `file_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "revision_ocr_coverage_status_check" CHECK("revision_ocr_coverage"."status" in ('none', 'partial', 'complete'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `revision_one_preferred_ocr_variant` ON `revision_ocr_coverage` (`revision_id`) WHERE "revision_ocr_coverage"."preferred" = 1;--> statement-breakpoint
CREATE TABLE `source_files` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`role` text NOT NULL,
	`label` text,
	`checkout_repo_id` text,
	`checkout_path` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`checkout_repo_id`) REFERENCES `archive_repositories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "source_files_role_check" CHECK("source_files"."role" in ('scan', 'epub', 'supplement', 'derivative')),
	CONSTRAINT "source_files_checkout_pair_check" CHECK(("source_files"."checkout_repo_id" is null and "source_files"."checkout_path" is null) or ("source_files"."checkout_repo_id" is not null and "source_files"."checkout_path" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_files_checkout_idx` ON `source_files` (`checkout_repo_id`,`checkout_path`);--> statement-breakpoint
CREATE INDEX `source_files_source` ON `source_files` (`source_id`);--> statement-breakpoint
CREATE TABLE `upload_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`source_file_id` text NOT NULL,
	`expected_sha256` text NOT NULL,
	`expected_bytes` integer NOT NULL,
	`declared_media_type` text NOT NULL,
	`staging_key` text NOT NULL,
	`multipart_id` text,
	`state` text NOT NULL,
	`submitted_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`error_code` text,
	FOREIGN KEY (`source_file_id`) REFERENCES `source_files`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`submitted_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "upload_sessions_expected_bytes_check" CHECK("upload_sessions"."expected_bytes" > 0),
	CONSTRAINT "upload_sessions_state_check" CHECK("upload_sessions"."state" in ('initiated', 'uploading', 'uploaded', 'finalizing', 'verified', 'failed', 'aborted', 'expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `upload_sessions_staging_key_idx` ON `upload_sessions` (`staging_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `upload_sessions_multipart_idx` ON `upload_sessions` (`multipart_id`);--> statement-breakpoint
CREATE TABLE `user_identities` (
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`kind`, `value`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "user_identities_kind_check" CHECK("user_identities"."kind" in ('access_sub', 'github_login', 'service_token'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_identities_user_kind_value_idx` ON `user_identities` (`user_id`,`kind`,`value`);--> statement-breakpoint
ALTER TABLE `sources` ADD `human_download` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `local_processing` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `hosted_ai_text` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `hosted_ai_images` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `bulk_export` integer DEFAULT false NOT NULL;