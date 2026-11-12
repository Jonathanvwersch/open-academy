ALTER TYPE "public"."lesson_run_status" ADD VALUE 'quiz' BEFORE 'completed';--> statement-breakpoint
CREATE TABLE "lesson_quiz_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"score" real,
	"passed" boolean
);
--> statement-breakpoint
CREATE TABLE "lesson_quiz_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quiz_attempt_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"knowledge_point_id" text NOT NULL,
	"exercise_id" text NOT NULL,
	"seed" integer,
	"answer" jsonb,
	"correct" real,
	"attempt_id" uuid,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "lesson_problems" ADD COLUMN "practice_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson_runs" ADD COLUMN "quiz_passed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "lesson_runs" SET "quiz_passed_at" = "completed_at" WHERE "status" = 'completed';--> statement-breakpoint
UPDATE "lesson_runs" SET "status" = 'in_progress' WHERE "status" = 'needs_retry';--> statement-breakpoint
ALTER TABLE "lesson_quiz_attempts" ADD CONSTRAINT "lesson_quiz_attempts_run_id_lesson_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."lesson_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_quiz_items" ADD CONSTRAINT "lesson_quiz_items_quiz_attempt_id_lesson_quiz_attempts_id_fk" FOREIGN KEY ("quiz_attempt_id") REFERENCES "public"."lesson_quiz_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_quiz_items" ADD CONSTRAINT "lesson_quiz_items_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_quiz_attempts" ADD CONSTRAINT "lesson_quiz_attempts_score_range" CHECK ("score" IS NULL OR ("score" >= 0 AND "score" <= 1));--> statement-breakpoint
CREATE UNIQUE INDEX "lesson_quiz_attempts_run_attempt_unique" ON "lesson_quiz_attempts" USING btree ("run_id","attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "lesson_quiz_items_attempt_position_unique" ON "lesson_quiz_items" USING btree ("quiz_attempt_id","position");--> statement-breakpoint