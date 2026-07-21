CREATE TABLE `github_login_cache` (
	`user_id` text PRIMARY KEY NOT NULL,
	`login` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
