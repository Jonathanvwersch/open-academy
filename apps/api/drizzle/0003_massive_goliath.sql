CREATE TYPE "public"."lesson_run_status" AS ENUM('in_progress', 'needs_retry', 'completed');--> statement-breakpoint
CREATE TYPE "public"."xp_event_kind" AS ENUM('knowledge_point', 'review', 'quiz', 'project');--> statement-breakpoint
CREATE TABLE "lesson_problems" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"knowledge_point_id" text NOT NULL,
	"round" integer NOT NULL,
	"position" integer NOT NULL,
	"exercise_id" text NOT NULL,
	"seed" integer,
	"served_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	"correct" real,
	"attempt_id" uuid
);
--> statement-breakpoint
CREATE TABLE "lesson_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"concept_id" text NOT NULL,
	"status" "lesson_run_status" DEFAULT 'in_progress' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "xp_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "xp_event_kind" NOT NULL,
	"source_key" text NOT NULL,
	"concept_id" text,
	"amount" integer NOT NULL,
	"earned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"local_date" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lesson_problems" ADD CONSTRAINT "lesson_problems_run_id_lesson_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."lesson_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_problems" ADD CONSTRAINT "lesson_problems_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_runs" ADD CONSTRAINT "lesson_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "xp_events" ADD CONSTRAINT "xp_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lesson_problems_run_point_round_position_unique" ON "lesson_problems" USING btree ("run_id","knowledge_point_id","round","position");--> statement-breakpoint
CREATE INDEX "lesson_problems_run_point_idx" ON "lesson_problems" USING btree ("run_id","knowledge_point_id","round");--> statement-breakpoint
CREATE UNIQUE INDEX "lesson_runs_user_concept_unique" ON "lesson_runs" USING btree ("user_id","concept_id");--> statement-breakpoint
CREATE INDEX "lesson_runs_user_status_idx" ON "lesson_runs" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "xp_events_user_source_unique" ON "xp_events" USING btree ("user_id","source_key");--> statement-breakpoint
CREATE INDEX "xp_events_user_local_date_idx" ON "xp_events" USING btree ("user_id","local_date");