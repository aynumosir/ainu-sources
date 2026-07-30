CREATE INDEX `file_revisions_review_status_current_idx` ON `file_revisions` (`review_status`,`is_current`);--> statement-breakpoint
CREATE INDEX `sources_title_idx` ON `sources` (`title`);--> statement-breakpoint
CREATE INDEX `sources_significance_idx` ON `sources` (`significance`);