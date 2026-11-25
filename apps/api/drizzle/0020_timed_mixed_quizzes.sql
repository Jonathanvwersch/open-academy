ALTER TYPE "public"."activity_kind" ADD VALUE 'mixed_quiz' BEFORE 'paper';--> statement-breakpoint
ALTER TYPE "public"."xp_event_kind" ADD VALUE 'mixed_quiz' BEFORE 'project';--> statement-breakpoint
CREATE TABLE "quiz_items" (
	"run_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"concept_id" text NOT NULL,
	"question" jsonb NOT NULL,
	"reserve" jsonb,
	"answered_at" timestamp with time zone,
	"latency_ms" integer,
	"correct" boolean,
	"follow_up" boolean DEFAULT false NOT NULL,
	"follow_up_activity_id" uuid,
	CONSTRAINT "quiz_items_run_id_position_pk" PRIMARY KEY("run_id","position")
);
--> statement-breakpoint
CREATE TABLE "quiz_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"activity_id" uuid,
	"retake_of" uuid,
	"seed" integer NOT NULL,
	"difficulty" integer NOT NULL,
	"planned_minutes" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"finalized_at" timestamp with time zone,
	"score" real,
	"xp_awarded" integer
);
--> statement-breakpoint
ALTER TABLE "quiz_items" ADD CONSTRAINT "quiz_items_run_id_quiz_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."quiz_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_items" ADD CONSTRAINT "quiz_items_follow_up_activity_id_session_activities_id_fk" FOREIGN KEY ("follow_up_activity_id") REFERENCES "public"."session_activities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_runs" ADD CONSTRAINT "quiz_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_runs" ADD CONSTRAINT "quiz_runs_activity_id_session_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."session_activities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_runs" ADD CONSTRAINT "quiz_runs_retake_of_quiz_runs_id_fk" FOREIGN KEY ("retake_of") REFERENCES "public"."quiz_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "quiz_runs_active_user_unique" ON "quiz_runs" USING btree ("user_id") WHERE "quiz_runs"."finalized_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "quiz_runs_retake_unique" ON "quiz_runs" USING btree ("retake_of");--> statement-breakpoint
CREATE INDEX "quiz_runs_user_started_idx" ON "quiz_runs" USING btree ("user_id","started_at");