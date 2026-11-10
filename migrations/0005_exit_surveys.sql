CREATE TABLE `exit_surveys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`reason` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`plan_key` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
