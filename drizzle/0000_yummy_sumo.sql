CREATE TABLE `institutions` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`name_en` text,
	`country` text,
	`city` text,
	`lat` real,
	`lng` real,
	`url` text,
	`wikidata` text,
	`notes` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `institutions_slug_idx` ON `institutions` (`slug`);--> statement-breakpoint
CREATE TABLE `persons` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`name_en` text,
	`name_kana` text,
	`name_ain` text,
	`birth_year` integer,
	`death_year` integer,
	`wikidata` text,
	`bio` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `persons_slug_idx` ON `persons` (`slug`);--> statement-breakpoint
CREATE TABLE `places` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`name_en` text,
	`name_ain` text,
	`kind` text DEFAULT 'region' NOT NULL,
	`region` text,
	`lat` real,
	`lng` real,
	`geonames` text,
	`wikidata` text,
	`notes` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `places_slug_idx` ON `places` (`slug`);--> statement-breakpoint
CREATE TABLE `source_institutions` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`institution_id` text NOT NULL,
	`role` text DEFAULT 'holding' NOT NULL,
	`call_number` text,
	`notes` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `source_institutions_source_idx` ON `source_institutions` (`source_id`);--> statement-breakpoint
CREATE INDEX `source_institutions_institution_idx` ON `source_institutions` (`institution_id`);--> statement-breakpoint
CREATE TABLE `source_links` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`type` text DEFAULT 'website' NOT NULL,
	`label` text,
	`url` text NOT NULL,
	`notes` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `source_links_source_idx` ON `source_links` (`source_id`);--> statement-breakpoint
CREATE TABLE `source_persons` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`person_id` text NOT NULL,
	`role` text DEFAULT 'author' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `source_persons_source_idx` ON `source_persons` (`source_id`);--> statement-breakpoint
CREATE INDEX `source_persons_person_idx` ON `source_persons` (`person_id`);--> statement-breakpoint
CREATE TABLE `source_places` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`place_id` text NOT NULL,
	`role` text DEFAULT 'dialect' NOT NULL,
	`notes` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`place_id`) REFERENCES `places`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `source_places_source_idx` ON `source_places` (`source_id`);--> statement-breakpoint
CREATE INDEX `source_places_place_idx` ON `source_places` (`place_id`);--> statement-breakpoint
CREATE TABLE `source_relations` (
	`id` text PRIMARY KEY NOT NULL,
	`from_source_id` text NOT NULL,
	`to_source_id` text NOT NULL,
	`type` text DEFAULT 'related' NOT NULL,
	`notes` text,
	FOREIGN KEY (`from_source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `source_relations_from_idx` ON `source_relations` (`from_source_id`);--> statement-breakpoint
CREATE INDEX `source_relations_to_idx` ON `source_relations` (`to_source_id`);--> statement-breakpoint
CREATE TABLE `source_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`user_id` text,
	`user_name` text,
	`summary` text,
	`action` text DEFAULT 'update' NOT NULL,
	`snapshot` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `source_revisions_source_idx` ON `source_revisions` (`source_id`);--> statement-breakpoint
CREATE TABLE `source_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`tag_id` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `source_tags_source_idx` ON `source_tags` (`source_id`);--> statement-breakpoint
CREATE INDEX `source_tags_tag_idx` ON `source_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`title_en` text,
	`title_ain` text,
	`alt_titles` text,
	`category` text DEFAULT 'primary' NOT NULL,
	`type` text NOT NULL,
	`author` text,
	`year_text` text,
	`year_start` integer,
	`year_end` integer,
	`year_certainty` text DEFAULT 'exact',
	`dialect` text,
	`region` text,
	`languages` text,
	`scripts` text,
	`holding_institution` text,
	`call_number` text,
	`entry_count` integer,
	`entry_count_label` text,
	`license` text,
	`summary` text,
	`notes` text,
	`reliability` text,
	`provenance_repo` text DEFAULT 'manual' NOT NULL,
	`provenance_path` text,
	`external_ids` text,
	`featured` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text,
	`updated_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sources_slug_idx` ON `sources` (`slug`);--> statement-breakpoint
CREATE INDEX `sources_type_idx` ON `sources` (`type`);--> statement-breakpoint
CREATE INDEX `sources_category_idx` ON `sources` (`category`);--> statement-breakpoint
CREATE INDEX `sources_region_idx` ON `sources` (`region`);--> statement-breakpoint
CREATE INDEX `sources_year_idx` ON `sources` (`year_start`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`name_en` text,
	`category` text DEFAULT 'topic' NOT NULL,
	`description` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_slug_idx` ON `tags` (`slug`);--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);