CREATE TABLE `person_slug_redirects` (
	`old_slug` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `person_slug_redirects_person_idx` ON `person_slug_redirects` (`person_id`);--> statement-breakpoint
ALTER TABLE `persons` ADD `merged_into_person_id` text REFERENCES persons(id);