CREATE TABLE `app_user_roles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`role` text DEFAULT 'editor' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `migration_watermarks` (
	`job_name` text PRIMARY KEY NOT NULL,
	`phase` text,
	`cursor` text,
	`last_source_id` text,
	`last_observation_id` text,
	`status` text,
	`summary` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source_field_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`observation_id` text NOT NULL,
	`source_id` text NOT NULL,
	`field_name` text NOT NULL,
	`value` text,
	`value_hash` text NOT NULL,
	`op` text DEFAULT 'set' NOT NULL,
	`rank_band` integer NOT NULL,
	`rank_score` integer NOT NULL,
	`origin` text,
	`derivation` text,
	`confidence` real,
	`evidence` integer,
	`status` text DEFAULT 'submitted' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`observation_id`) REFERENCES `source_observations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_field_claims_dedupe_idx` ON `source_field_claims` (`observation_id`,`field_name`,`value_hash`);--> statement-breakpoint
CREATE INDEX `source_field_claims_source_field_idx` ON `source_field_claims` (`source_id`,`field_name`);--> statement-breakpoint
CREATE TABLE `source_field_provenance` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`field_name` text NOT NULL,
	`current_claim_id` text,
	`value_hash` text,
	`rank_band` integer,
	`rank_score` integer,
	`origin` text,
	`derivation` text,
	`confidence` real,
	`evidence` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`current_claim_id`) REFERENCES `source_field_claims`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_field_provenance_source_field_idx` ON `source_field_provenance` (`source_id`,`field_name`);--> statement-breakpoint
CREATE TABLE `source_identifiers` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text,
	`kind` text NOT NULL,
	`value_raw` text NOT NULL,
	`value_norm` text NOT NULL,
	`strength` text DEFAULT 'medium' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`redirects_to_identifier_id` text,
	`canonical_value_norm` text,
	`origin` text,
	`confidence` real,
	`observation_id` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`redirects_to_identifier_id`) REFERENCES `source_identifiers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`observation_id`) REFERENCES `source_observations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_identifiers_kind_value_idx` ON `source_identifiers` (`kind`,`value_norm`);--> statement-breakpoint
CREATE INDEX `source_identifiers_source_idx` ON `source_identifiers` (`source_id`);--> statement-breakpoint
CREATE TABLE `source_lifecycle_events` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`observation_id` text,
	`event_type` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`from_merged_into` text,
	`to_merged_into` text,
	`reason` text,
	`actor` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`observation_id`) REFERENCES `source_observations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`from_merged_into`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`to_merged_into`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `source_lifecycle_events_source_idx` ON `source_lifecycle_events` (`source_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `source_observation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`origin` text NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`collector_version` text,
	`normalizer_version` integer NOT NULL,
	`summary` text,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `source_observation_runs_origin_idx` ON `source_observation_runs` (`origin`);--> statement-breakpoint
CREATE TABLE `source_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`origin` text NOT NULL,
	`origin_record_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`normalizer_version` integer NOT NULL,
	`run_id` text,
	`derivation` text NOT NULL,
	`confidence` real NOT NULL,
	`evidence` integer DEFAULT 0 NOT NULL,
	`payload` text NOT NULL,
	`raw_payload` text,
	`status` text DEFAULT 'submitted' NOT NULL,
	`match_decision` text,
	`actor` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `source_observation_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_observations_idempotency_idx` ON `source_observations` (`origin`,`origin_record_id`,`content_hash`);--> statement-breakpoint
CREATE INDEX `source_observations_origin_record_idx` ON `source_observations` (`origin`,`origin_record_id`);--> statement-breakpoint
CREATE TABLE `source_observed_records` (
	`id` text PRIMARY KEY NOT NULL,
	`origin` text NOT NULL,
	`origin_record_id` text NOT NULL,
	`status` text DEFAULT 'seen' NOT NULL,
	`last_content_hash` text,
	`normalizer_version` integer NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`content_changed_at` integer,
	`missing_since_at` integer,
	`missing_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_observed_records_origin_record_idx` ON `source_observed_records` (`origin`,`origin_record_id`);--> statement-breakpoint
ALTER TABLE `institutions` ADD `ror` text;--> statement-breakpoint
ALTER TABLE `institutions` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `institutions` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `institutions` ADD `first_seen_at` integer;--> statement-breakpoint
ALTER TABLE `institutions` ADD `last_seen_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `institutions_ror_idx` ON `institutions` (`ror`) WHERE "institutions"."ror" is not null;--> statement-breakpoint
ALTER TABLE `persons` ADD `orcid` text;--> statement-breakpoint
ALTER TABLE `persons` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `persons` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `persons` ADD `first_seen_at` integer;--> statement-breakpoint
ALTER TABLE `persons` ADD `last_seen_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `persons_orcid_idx` ON `persons` (`orcid`) WHERE "persons"."orcid" is not null;--> statement-breakpoint
ALTER TABLE `places` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `places` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `places` ADD `first_seen_at` integer;--> statement-breakpoint
ALTER TABLE `places` ADD `last_seen_at` integer;--> statement-breakpoint
ALTER TABLE `source_institutions` ADD `status` text DEFAULT 'active';--> statement-breakpoint
ALTER TABLE `source_institutions` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `source_institutions` ADD `observation_id` text REFERENCES source_observations(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `source_institutions` ADD `confidence` real;--> statement-breakpoint
ALTER TABLE `source_institutions` ADD `first_seen_at` integer;--> statement-breakpoint
ALTER TABLE `source_institutions` ADD `last_seen_at` integer;--> statement-breakpoint
ALTER TABLE `source_links` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `source_links` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `source_links` ADD `derivation` text;--> statement-breakpoint
ALTER TABLE `source_links` ADD `confidence` real;--> statement-breakpoint
ALTER TABLE `source_links` ADD `evidence` integer;--> statement-breakpoint
ALTER TABLE `source_links` ADD `content_hash` text;--> statement-breakpoint
ALTER TABLE `source_links` ADD `observation_id` text REFERENCES source_observations(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `source_links` ADD `first_seen_at` integer;--> statement-breakpoint
ALTER TABLE `source_links` ADD `last_seen_at` integer;--> statement-breakpoint
ALTER TABLE `source_persons` ADD `status` text DEFAULT 'active';--> statement-breakpoint
ALTER TABLE `source_persons` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `source_persons` ADD `observation_id` text REFERENCES source_observations(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `source_persons` ADD `confidence` real;--> statement-breakpoint
ALTER TABLE `source_persons` ADD `first_seen_at` integer;--> statement-breakpoint
ALTER TABLE `source_persons` ADD `last_seen_at` integer;--> statement-breakpoint
ALTER TABLE `source_places` ADD `status` text DEFAULT 'active';--> statement-breakpoint
ALTER TABLE `source_places` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `source_places` ADD `observation_id` text REFERENCES source_observations(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `source_places` ADD `confidence` real;--> statement-breakpoint
ALTER TABLE `source_places` ADD `first_seen_at` integer;--> statement-breakpoint
ALTER TABLE `source_places` ADD `last_seen_at` integer;--> statement-breakpoint
ALTER TABLE `source_relations` ADD `status` text DEFAULT 'accepted' NOT NULL;--> statement-breakpoint
ALTER TABLE `source_relations` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `source_relations` ADD `derivation` text;--> statement-breakpoint
ALTER TABLE `source_relations` ADD `confidence` real;--> statement-breakpoint
ALTER TABLE `source_relations` ADD `evidence` integer;--> statement-breakpoint
ALTER TABLE `source_relations` ADD `observation_id` text REFERENCES source_observations(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `source_tags` ADD `status` text DEFAULT 'active';--> statement-breakpoint
ALTER TABLE `source_tags` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `source_tags` ADD `observation_id` text REFERENCES source_observations(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `source_tags` ADD `confidence` real;--> statement-breakpoint
ALTER TABLE `source_tags` ADD `first_seen_at` integer;--> statement-breakpoint
ALTER TABLE `source_tags` ADD `last_seen_at` integer;--> statement-breakpoint
ALTER TABLE `sources` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `merged_into_source_id` text REFERENCES sources(id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `sources` ADD `drift_status` text DEFAULT 'current' NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `content_hash` text;--> statement-breakpoint
ALTER TABLE `sources` ADD `normalizer_version` integer;--> statement-breakpoint
ALTER TABLE `sources` ADD `first_seen_at` integer;--> statement-breakpoint
ALTER TABLE `sources` ADD `last_seen_at` integer;--> statement-breakpoint
ALTER TABLE `sources` ADD `content_changed_at` integer;--> statement-breakpoint
CREATE INDEX `sources_status_idx` ON `sources` (`status`);--> statement-breakpoint
CREATE INDEX `sources_merged_into_idx` ON `sources` (`merged_into_source_id`);--> statement-breakpoint
CREATE INDEX `sources_content_hash_idx` ON `sources` (`content_hash`);--> statement-breakpoint
ALTER TABLE `tags` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `tags` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `tags` ADD `first_seen_at` integer;--> statement-breakpoint
ALTER TABLE `tags` ADD `last_seen_at` integer;