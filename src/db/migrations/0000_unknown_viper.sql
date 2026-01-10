CREATE TABLE `consult_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`decision` text NOT NULL,
	`context` text,
	`principles_found` integer NOT NULL,
	`patterns_found` integer NOT NULL,
	`guidance` text NOT NULL,
	`created_at` integer NOT NULL,
	`project` text
);
--> statement-breakpoint
CREATE INDEX `idx_consult_project` ON `consult_log` (`project`);--> statement-breakpoint
CREATE INDEX `idx_consult_created` ON `consult_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`context` text,
	`options` text,
	`decision` text,
	`rationale` text,
	`project` text,
	`tags` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by` text
);
--> statement-breakpoint
CREATE INDEX `idx_decisions_status` ON `decisions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_decisions_project` ON `decisions` (`project`);--> statement-breakpoint
CREATE INDEX `idx_decisions_created` ON `decisions` (`created_at`);--> statement-breakpoint
CREATE TABLE `document_access` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` text NOT NULL,
	`access_type` text,
	`created_at` integer NOT NULL,
	`project` text
);
--> statement-breakpoint
CREATE INDEX `idx_access_project` ON `document_access` (`project`);--> statement-breakpoint
CREATE INDEX `idx_access_created` ON `document_access` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_access_doc` ON `document_access` (`document_id`);--> statement-breakpoint
CREATE TABLE `forum_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread_id` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`author` text,
	`principles_found` integer,
	`patterns_found` integer,
	`search_query` text,
	`comment_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `forum_threads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_message_thread` ON `forum_messages` (`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_message_role` ON `forum_messages` (`role`);--> statement-breakpoint
CREATE INDEX `idx_message_created` ON `forum_messages` (`created_at`);--> statement-breakpoint
CREATE TABLE `forum_threads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`created_by` text DEFAULT 'human',
	`status` text DEFAULT 'active',
	`issue_url` text,
	`issue_number` integer,
	`project` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`synced_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_thread_status` ON `forum_threads` (`status`);--> statement-breakpoint
CREATE INDEX `idx_thread_project` ON `forum_threads` (`project`);--> statement-breakpoint
CREATE INDEX `idx_thread_created` ON `forum_threads` (`created_at`);--> statement-breakpoint
CREATE TABLE `indexing_status` (
	`id` integer PRIMARY KEY NOT NULL,
	`is_indexing` integer DEFAULT 0 NOT NULL,
	`progress_current` integer DEFAULT 0,
	`progress_total` integer DEFAULT 0,
	`started_at` integer,
	`completed_at` integer,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `learn_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` text NOT NULL,
	`pattern_preview` text,
	`source` text,
	`concepts` text,
	`created_at` integer NOT NULL,
	`project` text
);
--> statement-breakpoint
CREATE INDEX `idx_learn_project` ON `learn_log` (`project`);--> statement-breakpoint
CREATE INDEX `idx_learn_created` ON `learn_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `oracle_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`source_file` text NOT NULL,
	`concepts` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`indexed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_source` ON `oracle_documents` (`source_file`);--> statement-breakpoint
CREATE INDEX `idx_type` ON `oracle_documents` (`type`);--> statement-breakpoint
CREATE TABLE `search_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`query` text NOT NULL,
	`type` text,
	`mode` text,
	`results_count` integer,
	`search_time_ms` integer,
	`created_at` integer NOT NULL,
	`project` text
);
--> statement-breakpoint
CREATE INDEX `idx_search_project` ON `search_log` (`project`);--> statement-breakpoint
CREATE INDEX `idx_search_created` ON `search_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `trace_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trace_id` text NOT NULL,
	`query` text NOT NULL,
	`query_type` text DEFAULT 'general',
	`found_files` text,
	`found_commits` text,
	`found_issues` text,
	`found_retrospectives` text,
	`found_learnings` text,
	`found_resonance` text,
	`file_count` integer DEFAULT 0,
	`commit_count` integer DEFAULT 0,
	`issue_count` integer DEFAULT 0,
	`depth` integer DEFAULT 0,
	`parent_trace_id` text,
	`child_trace_ids` text DEFAULT '[]',
	`project` text,
	`session_id` text,
	`agent_count` integer DEFAULT 1,
	`duration_ms` integer,
	`status` text DEFAULT 'raw',
	`awakening` text,
	`distilled_to_id` text,
	`distilled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trace_log_trace_id_unique` ON `trace_log` (`trace_id`);--> statement-breakpoint
CREATE INDEX `idx_trace_query` ON `trace_log` (`query`);--> statement-breakpoint
CREATE INDEX `idx_trace_project` ON `trace_log` (`project`);--> statement-breakpoint
CREATE INDEX `idx_trace_status` ON `trace_log` (`status`);--> statement-breakpoint
CREATE INDEX `idx_trace_parent` ON `trace_log` (`parent_trace_id`);--> statement-breakpoint
CREATE INDEX `idx_trace_created` ON `trace_log` (`created_at`);