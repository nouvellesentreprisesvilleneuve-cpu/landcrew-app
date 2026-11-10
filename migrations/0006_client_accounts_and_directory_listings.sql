CREATE TABLE `client_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`region` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `directory_listings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`business_name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`services` text DEFAULT 'tonte' NOT NULL,
	`area` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`visible` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `quote_requests` ADD COLUMN `listing_id` integer REFERENCES `directory_listings`(`id`);
--> statement-breakpoint
ALTER TABLE `quote_requests` ADD COLUMN `client_account_id` integer REFERENCES `client_accounts`(`id`);
