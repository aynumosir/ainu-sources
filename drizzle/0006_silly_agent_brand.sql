CREATE TABLE `change_request_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`change_request_id` text NOT NULL,
	`reviewer_kind` text NOT NULL,
	`reviewer_actor` text,
	`verdict` text NOT NULL,
	`confidence` real,
	`reason` text NOT NULL,
	`evidence_refs` text,
	`payload` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`change_request_id`) REFERENCES `change_requests`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `cr_reviews_cr_idx` ON `change_request_reviews` (`change_request_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `change_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`observation_id` text NOT NULL,
	`source_id` text,
	`planned_source_id` text,
	`planned_slug` text,
	`kind` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`routing_reason` text NOT NULL,
	`title` text,
	`summary` text,
	`origin` text NOT NULL,
	`origin_record_id` text NOT NULL,
	`derivation` text NOT NULL,
	`confidence` real NOT NULL,
	`evidence` integer DEFAULT 0 NOT NULL,
	`base_content_hash` text,
	`result_content_hash` text,
	`proposed_by_actor` text,
	`decided_by_actor` text,
	`decided_at` integer,
	`applied_observation_status` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`observation_id`) REFERENCES `source_observations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `change_requests_observation_idx` ON `change_requests` (`observation_id`);--> statement-breakpoint
CREATE INDEX `change_requests_status_idx` ON `change_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `change_requests_source_idx` ON `change_requests` (`source_id`);--> statement-breakpoint
CREATE INDEX `change_requests_origin_record_idx` ON `change_requests` (`origin`,`origin_record_id`);