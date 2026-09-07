CREATE INDEX `institutions_sitemap_idx` ON `institutions` (`status`,`slug`);--> statement-breakpoint
CREATE INDEX `persons_sitemap_idx` ON `persons` (`status`,`slug`,`updated_at`);--> statement-breakpoint
CREATE INDEX `places_sitemap_idx` ON `places` (`status`,`slug`);--> statement-breakpoint
CREATE INDEX `sources_sitemap_idx` ON `sources` (`status`,`slug`,`updated_at`);
