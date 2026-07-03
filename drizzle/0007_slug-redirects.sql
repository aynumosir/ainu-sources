CREATE TABLE `slug_redirects` (
	`old_slug` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `slug_redirects_source_idx` ON `slug_redirects` (`source_id`);