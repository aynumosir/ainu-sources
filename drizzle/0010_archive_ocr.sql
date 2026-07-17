CREATE TABLE `ocr_ingest_state` (
	`revision_id` text NOT NULL,
	`variant` text NOT NULL,
	`content_hash` text NOT NULL,
	`page_count` integer NOT NULL,
	`ingested_at` integer NOT NULL,
	PRIMARY KEY(`revision_id`, `variant`),
	FOREIGN KEY (`revision_id`) REFERENCES `file_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ocr_ingest_state_hash_check" CHECK(length(`content_hash`) = 64 and `content_hash` not glob '*[^0-9a-f]*'),
	CONSTRAINT "ocr_ingest_state_page_count_check" CHECK(`page_count` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ocr_ingest_state_revision_variant_idx` ON `ocr_ingest_state` (`revision_id`,`variant`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `ocr_pages` USING fts5(
	`revision_id` UNINDEXED,
	`variant` UNINDEXED,
	`page` UNINDEXED,
	`text`
);
