DROP TABLE IF EXISTS `decisions`;--> statement-breakpoint
ALTER TABLE `trace_log` ADD `scope` text DEFAULT 'project';