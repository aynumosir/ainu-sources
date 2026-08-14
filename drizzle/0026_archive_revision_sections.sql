CREATE TABLE `revision_sections` (
	`id` text PRIMARY KEY NOT NULL,
	`revision_id` text NOT NULL,
	`ord` integer NOT NULL,
	`depth` integer DEFAULT 1 NOT NULL,
	`title` text NOT NULL,
	`title_en` text,
	`page_start` integer NOT NULL,
	`page_end` integer,
	`origin` text DEFAULT 'curated' NOT NULL,
	`confidence` real,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `file_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "revision_sections_page_check" CHECK("revision_sections"."page_start" >= 1),
	CONSTRAINT "revision_sections_page_range_check" CHECK("revision_sections"."page_end" is null or "revision_sections"."page_end" >= "revision_sections"."page_start"),
	CONSTRAINT "revision_sections_depth_check" CHECK("revision_sections"."depth" >= 1),
	CONSTRAINT "revision_sections_origin_check" CHECK("revision_sections"."origin" in ('toc', 'headings', 'curated'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `revision_sections_order_idx` ON `revision_sections` (`revision_id`,`ord`);