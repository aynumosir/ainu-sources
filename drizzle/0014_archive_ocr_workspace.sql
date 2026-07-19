CREATE TABLE `ocr_page_edits` (
	`edit_id` text PRIMARY KEY NOT NULL,
	`revision_id` text NOT NULL,
	`page` integer NOT NULL,
	`variant` text NOT NULL,
	`text` text NOT NULL,
	`base_edit_id` text,
	`base_variant` text,
	`note` text,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `file_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`base_edit_id`) REFERENCES `ocr_page_edits`(`edit_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`author`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ocr_page_edits_page_check" CHECK(`page` >= 0),
	CONSTRAINT "ocr_page_edits_variant_check" CHECK(`variant` in ('edited', 'manual')),
	CONSTRAINT "ocr_page_edits_base_check" CHECK((`base_edit_id` is not null and `base_variant` is null) or (`base_edit_id` is null and `base_variant` is not null))
);
--> statement-breakpoint
CREATE INDEX `ocr_page_edits_revision_page_created_idx` ON `ocr_page_edits` (`revision_id`,`page`,`created_at`);
--> statement-breakpoint
CREATE INDEX `ocr_page_edits_base_edit_idx` ON `ocr_page_edits` (`base_edit_id`);
--> statement-breakpoint
CREATE TABLE `ocr_page_state` (
	`revision_id` text NOT NULL,
	`page` integer NOT NULL,
	`current_edit_id` text,
	`status` text DEFAULT 'machine' NOT NULL,
	`approver` text,
	`approved_at` integer,
	PRIMARY KEY(`revision_id`, `page`),
	FOREIGN KEY (`revision_id`) REFERENCES `file_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`current_edit_id`) REFERENCES `ocr_page_edits`(`edit_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`approver`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ocr_page_state_page_check" CHECK(`page` >= 0),
	CONSTRAINT "ocr_page_state_status_check" CHECK(`status` in ('machine', 'edited', 'approved')),
	CONSTRAINT "ocr_page_state_value_check" CHECK((`status` = 'machine' and `current_edit_id` is null and `approver` is null and `approved_at` is null) or (`status` = 'edited' and `current_edit_id` is not null and `approver` is null and `approved_at` is null) or (`status` = 'approved' and `current_edit_id` is not null and `approver` is not null and `approved_at` is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ocr_page_state_current_edit_idx` ON `ocr_page_state` (`current_edit_id`);
--> statement-breakpoint
CREATE TABLE `ocr_page_edit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`revision_id` text NOT NULL,
	`page` integer NOT NULL,
	`kind` text NOT NULL,
	`edit_id` text,
	`actor` text NOT NULL,
	`note` text,
	`base_edit_id` text,
	`restored_from` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `file_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`edit_id`) REFERENCES `ocr_page_edits`(`edit_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`base_edit_id`) REFERENCES `ocr_page_edits`(`edit_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`restored_from`) REFERENCES `ocr_page_edits`(`edit_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ocr_page_edit_events_page_check" CHECK(`page` >= 0),
	CONSTRAINT "ocr_page_edit_events_kind_check" CHECK(`kind` in ('edit', 'approve', 'unapprove', 'demote', 'revert'))
);
--> statement-breakpoint
CREATE INDEX `ocr_page_edit_events_page_cursor_idx` ON `ocr_page_edit_events` (`revision_id`,`page`,`id`);
--> statement-breakpoint
CREATE TRIGGER `ocr_page_edits_no_update`
BEFORE UPDATE ON `ocr_page_edits`
BEGIN
	SELECT RAISE(ABORT, 'ocr_page_edits is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `ocr_page_edits_no_delete`
BEFORE DELETE ON `ocr_page_edits`
BEGIN
	SELECT RAISE(ABORT, 'ocr_page_edits is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `ocr_page_edit_events_no_update`
BEFORE UPDATE ON `ocr_page_edit_events`
BEGIN
	SELECT RAISE(ABORT, 'ocr_page_edit_events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `ocr_page_edit_events_no_delete`
BEFORE DELETE ON `ocr_page_edit_events`
BEGIN
	SELECT RAISE(ABORT, 'ocr_page_edit_events is append-only');
END;
