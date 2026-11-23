ALTER TABLE "lesson_runs" ADD COLUMN "attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_runs" ADD COLUMN "halted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lesson_runs" ADD COLUMN "retry_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lesson_runs" ADD COLUMN "halted_point_index" integer;--> statement-breakpoint
ALTER TABLE "lesson_runs" ADD COLUMN "halt_count" integer DEFAULT 0 NOT NULL;