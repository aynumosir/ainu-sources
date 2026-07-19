ALTER TABLE `ocr_ingest_state` ADD `active_generation` text NOT NULL DEFAULT 'legacy-0013';
--> statement-breakpoint
CREATE TABLE `ocr_chunks` (
	`chunk_id` text PRIMARY KEY NOT NULL,
	`revision_id` text NOT NULL,
	`variant` text NOT NULL,
	`page` integer NOT NULL,
	`block` integer NOT NULL,
	`text` text NOT NULL,
	`text_norm` text NOT NULL,
	`checksum` text NOT NULL,
	`normalization_version` integer NOT NULL,
	`ingest_generation` text NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `file_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ocr_chunks_page_check" CHECK(`page` >= 0),
	CONSTRAINT "ocr_chunks_block_check" CHECK(`block` >= 0),
	CONSTRAINT "ocr_chunks_normalization_version_check" CHECK(`normalization_version` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ocr_chunks_generation_location_idx` ON `ocr_chunks` (`ingest_generation`,`revision_id`,`variant`,`page`,`block`);
--> statement-breakpoint
CREATE INDEX `ocr_chunks_active_lookup_idx` ON `ocr_chunks` (`revision_id`,`variant`,`ingest_generation`,`page`,`block`);
--> statement-breakpoint
INSERT INTO `ocr_chunks` (`chunk_id`, `revision_id`, `variant`, `page`, `block`, `text`, `text_norm`, `checksum`, `normalization_version`, `ingest_generation`)
SELECT
	'legacy-0013:' || `revision_id` || ':' || `variant` || ':' || cast(`page` AS text),
	`revision_id`,
	`variant`,
	cast(`page` AS integer),
	0,
	`text`,
	lower(`text`),
	coalesce((SELECT `content_hash` FROM `ocr_ingest_state` s WHERE s.`revision_id` = p.`revision_id` AND s.`variant` = p.`variant`), ''),
	0,
	'legacy-0013'
FROM `ocr_pages` p;
--> statement-breakpoint
CREATE VIRTUAL TABLE `ocr_chunks_fts` USING fts5(
	`text`,
	`text_norm`,
	content='ocr_chunks',
	content_rowid='rowid',
	tokenize='trigram'
);
--> statement-breakpoint
INSERT INTO `ocr_chunks_fts` (`rowid`, `text`, `text_norm`)
SELECT `rowid`, `text`, `text_norm` FROM `ocr_chunks`;
--> statement-breakpoint
CREATE TRIGGER `ocr_chunks_ai` AFTER INSERT ON `ocr_chunks` BEGIN
	INSERT INTO `ocr_chunks_fts` (`rowid`, `text`, `text_norm`) VALUES (new.`rowid`, new.`text`, new.`text_norm`);
END;
--> statement-breakpoint
CREATE TRIGGER `ocr_chunks_ad` AFTER DELETE ON `ocr_chunks` BEGIN
	INSERT INTO `ocr_chunks_fts` (`ocr_chunks_fts`, `rowid`, `text`, `text_norm`) VALUES ('delete', old.`rowid`, old.`text`, old.`text_norm`);
END;
--> statement-breakpoint
CREATE TRIGGER `ocr_chunks_au` AFTER UPDATE ON `ocr_chunks` BEGIN
	INSERT INTO `ocr_chunks_fts` (`ocr_chunks_fts`, `rowid`, `text`, `text_norm`) VALUES ('delete', old.`rowid`, old.`text`, old.`text_norm`);
	INSERT INTO `ocr_chunks_fts` (`rowid`, `text`, `text_norm`) VALUES (new.`rowid`, new.`text`, new.`text_norm`);
END;
--> statement-breakpoint
CREATE TABLE `ocr_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_norm` text NOT NULL,
	`revision_id` text NOT NULL,
	`variant` text NOT NULL,
	`page` integer NOT NULL,
	`block` integer NOT NULL,
	`position` integer NOT NULL,
	`chunk_id` text NOT NULL,
	`ingest_generation` text NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `file_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chunk_id`) REFERENCES `ocr_chunks`(`chunk_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ocr_tokens_page_check" CHECK(`page` >= 0),
	CONSTRAINT "ocr_tokens_block_check" CHECK(`block` >= 0),
	CONSTRAINT "ocr_tokens_position_check" CHECK(`position` >= 0)
);
--> statement-breakpoint
CREATE INDEX `ocr_tokens_norm_idx` ON `ocr_tokens` (`token_norm`,`revision_id`,`variant`,`ingest_generation`);
--> statement-breakpoint
CREATE INDEX `ocr_tokens_chunk_position_idx` ON `ocr_tokens` (`chunk_id`,`position`);
--> statement-breakpoint
DROP TABLE `ocr_pages`;
