ALTER TABLE `oracle_documents` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `oracle_documents` ADD `project` text;--> statement-breakpoint
ALTER TABLE `oracle_documents` ADD `created_by` text;--> statement-breakpoint
CREATE INDEX `idx_origin` ON `oracle_documents` (`origin`);--> statement-breakpoint
CREATE INDEX `idx_project` ON `oracle_documents` (`project`);--> statement-breakpoint
ALTER TABLE `search_log` ADD `results` text;