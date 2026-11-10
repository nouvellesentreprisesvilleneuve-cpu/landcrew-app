-- Multi-entreprise (2026-11-10) : chaque entreprise a son espace privé.
-- La compagnie nº 1 est Tonte-O-Max (Maxime Villeneuve, le créateur du
-- programme, forfait « createur » gratuit à vie) et TOUTES les données
-- existantes lui appartiennent (company_id = 1 partout par défaut).
-- Le code d'accès initial de la compagnie nº 1 est stocké haché
-- (SHA-256) ; le code en clair est communiqué au propriétaire dans le
-- rapport de livraison et peut être changé dans Réglages.
CREATE TABLE `companies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`owner_email` text NOT NULL,
	`access_code_hash` text NOT NULL,
	`join_code` text NOT NULL,
	`plan` text DEFAULT 'essai' NOT NULL,
	`trial_ends_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `companies_owner_email_unique` ON `companies` (`owner_email`);
--> statement-breakpoint
CREATE UNIQUE INDEX `companies_join_code_unique` ON `companies` (`join_code`);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token` text NOT NULL,
	`company_id` integer NOT NULL REFERENCES `companies`(`id`),
	`role` text NOT NULL,
	`employee_id` integer REFERENCES `employees`(`id`),
	`created_at` integer NOT NULL,
	`expires_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token`);
--> statement-breakpoint
INSERT INTO `companies` (`id`, `name`, `owner_email`, `access_code_hash`, `join_code`, `plan`, `trial_ends_at`, `created_at`, `updated_at`) VALUES (1, 'Tonte-O-Max', 'tonte.o.max.777@gmail.com', 'a3184298efd4bed33668258ed8065d34758ca00c9083a45b102c479d06374c31', 'TMX-4393', 'createur', NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
--> statement-breakpoint
ALTER TABLE `clients` ADD COLUMN `company_id` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `terrains` ADD COLUMN `company_id` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `employees` ADD COLUMN `company_id` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `quotes` ADD COLUMN `company_id` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `quote_requests` ADD COLUMN `company_id` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `directory_listings` ADD COLUMN `company_id` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `time_events` ADD COLUMN `company_id` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `routes` ADD COLUMN `company_id` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `route_stops` ADD COLUMN `company_id` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `exit_surveys` ADD COLUMN `company_id` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `client_accounts` ADD COLUMN `company_id` integer;
--> statement-breakpoint
-- Les réglages (forfait, accès créateur, NEQ, taux…) deviennent par
-- entreprise : les clés existantes, qui appartiennent à la compagnie
-- nº 1, sont copiées sous le préfixe « co:1: ». Les clés d'origine sont
-- gardées intactes (secours).
INSERT INTO `settings` (`key`, `value`) SELECT 'co:1:' || `key`, `value` FROM `settings` WHERE `key` NOT LIKE 'co:%';
