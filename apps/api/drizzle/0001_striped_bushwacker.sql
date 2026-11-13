CREATE TYPE "public"."activity_kind" AS ENUM('review', 'learn', 'practice', 'remediate', 'quick_check', 'transfer', 'lab', 'reflect', 'teachback', 'diagnostic');--> statement-breakpoint
CREATE TYPE "public"."activity_status" AS ENUM('planned', 'in_progress', 'completed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."attempt_mode" AS ENUM('practice', 'assessment', 'diagnostic', 'review');--> statement-breakpoint
CREATE TYPE "public"."diagnostic_kind" AS ENUM('baseline', 'day30', 'day60', 'day90');--> statement-breakpoint
CREATE TYPE "public"."diagnostic_status" AS ENUM('active', 'completed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."hint_source" AS ENUM('authored', 'llm');--> statement-breakpoint
CREATE TYPE "public"."mastery_state" AS ENUM('not_assessed', 'introduced', 'assisted', 'independent', 'retained');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('not_started', 'in_progress', 'completed');--> statement-breakpoint
CREATE TYPE "public"."remediation_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."session_kind" AS ENUM('weekday', 'saturday', 'sunday', 'custom');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('planned', 'active', 'completed', 'abandoned');--> statement-breakpoint
CREATE TABLE "attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid,
	"activity_id" uuid,
	"exercise_id" text NOT NULL,
	"exercise_version" text NOT NULL,
	"concept_id" text NOT NULL,
	"dimension" text NOT NULL,
	"mode" "attempt_mode" NOT NULL,
	"answer" jsonb NOT NULL,
	"correct" real NOT NULL,
	"credit" real NOT NULL,
	"hints_used" integer DEFAULT 0 NOT NULL,
	"attempt_no" integer DEFAULT 1 NOT NULL,
	"graded_by" text NOT NULL,
	"feedback" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mistake_category" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diagnostic_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "diagnostic_kind" DEFAULT 'baseline' NOT NULL,
	"status" "diagnostic_status" DEFAULT 'active' NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hint_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"activity_id" uuid,
	"exercise_id" text NOT NULL,
	"level" integer NOT NULL,
	"source" "hint_source" DEFAULT 'authored' NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prompt_id" text NOT NULL,
	"prompt_version" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" real,
	"latency_ms" integer,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mastery" (
	"user_id" uuid NOT NULL,
	"concept_id" text NOT NULL,
	"dimension" text NOT NULL,
	"state" "mastery_state" DEFAULT 'not_assessed' NOT NULL,
	"provisional" boolean DEFAULT false NOT NULL,
	"inferred" boolean DEFAULT false NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_assessed_at" timestamp with time zone,
	"last_independent_at" timestamp with time zone,
	"first_independent_at" timestamp with time zone,
	CONSTRAINT "mastery_user_id_concept_id_dimension_pk" PRIMARY KEY("user_id","concept_id","dimension")
);
--> statement-breakpoint
CREATE TABLE "mastery_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"concept_id" text NOT NULL,
	"dimension" text NOT NULL,
	"from_state" "mastery_state" NOT NULL,
	"to_state" "mastery_state" NOT NULL,
	"rule" text NOT NULL,
	"attempt_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_progress" (
	"user_id" uuid NOT NULL,
	"project_id" text NOT NULL,
	"status" "project_status" DEFAULT 'not_started' NOT NULL,
	"task_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "project_progress_user_id_project_id_pk" PRIMARY KEY("user_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "project_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" text NOT NULL,
	"results" jsonb NOT NULL,
	"passed" integer NOT NULL,
	"total" integer NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remediation_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"concept_id" text NOT NULL,
	"target_prereq_id" text,
	"status" "remediation_status" DEFAULT 'open' NOT NULL,
	"opened_by_attempt_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "review_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"concept_id" text NOT NULL,
	"dimension" text NOT NULL,
	"fsrs" jsonb NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"last_review_at" timestamp with time zone,
	"reps" integer DEFAULT 0 NOT NULL,
	"lapses" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"attempt_id" uuid,
	"rating" text NOT NULL,
	"fsrs_log" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"kind" "activity_kind" NOT NULL,
	"concept_id" text,
	"project_id" text,
	"exercise_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"planned_minutes" integer NOT NULL,
	"status" "activity_status" DEFAULT 'planned' NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "study_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "session_kind" DEFAULT 'weekday' NOT NULL,
	"planned_minutes" integer NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"status" "session_status" DEFAULT 'planned' NOT NULL,
	"plan" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active_seconds" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tutor_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"activity_id" uuid,
	"exercise_id" text,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"llm_call_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "start_date" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "prefs" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_session_id_study_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."study_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_activity_id_session_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."session_activities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnostic_runs" ADD CONSTRAINT "diagnostic_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hint_events" ADD CONSTRAINT "hint_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hint_events" ADD CONSTRAINT "hint_events_activity_id_session_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."session_activities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastery" ADD CONSTRAINT "mastery_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastery_events" ADD CONSTRAINT "mastery_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mastery_events" ADD CONSTRAINT "mastery_events_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_progress" ADD CONSTRAINT "project_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_submissions" ADD CONSTRAINT "project_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remediation_flags" ADD CONSTRAINT "remediation_flags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remediation_flags" ADD CONSTRAINT "remediation_flags_opened_by_attempt_id_attempts_id_fk" FOREIGN KEY ("opened_by_attempt_id") REFERENCES "public"."attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_cards" ADD CONSTRAINT "review_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_logs" ADD CONSTRAINT "review_logs_card_id_review_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."review_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_logs" ADD CONSTRAINT "review_logs_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_activities" ADD CONSTRAINT "session_activities_session_id_study_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."study_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_sessions" ADD CONSTRAINT "study_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutor_messages" ADD CONSTRAINT "tutor_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tutor_messages" ADD CONSTRAINT "tutor_messages_activity_id_session_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."session_activities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attempts_user_concept_created_idx" ON "attempts" USING btree ("user_id","concept_id","created_at");--> statement-breakpoint
CREATE INDEX "attempts_activity_exercise_idx" ON "attempts" USING btree ("activity_id","exercise_id","attempt_no");--> statement-breakpoint
CREATE INDEX "diagnostic_runs_user_status_idx" ON "diagnostic_runs" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "hint_events_activity_exercise_idx" ON "hint_events" USING btree ("activity_id","exercise_id");--> statement-breakpoint
CREATE INDEX "mastery_user_state_idx" ON "mastery" USING btree ("user_id","state");--> statement-breakpoint
CREATE INDEX "mastery_events_user_concept_created_idx" ON "mastery_events" USING btree ("user_id","concept_id","created_at");--> statement-breakpoint
CREATE INDEX "remediation_flags_user_status_idx" ON "remediation_flags" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "review_cards_user_concept_dimension_unique" ON "review_cards" USING btree ("user_id","concept_id","dimension");--> statement-breakpoint
CREATE INDEX "review_cards_user_due_idx" ON "review_cards" USING btree ("user_id","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "session_activities_session_idx_unique" ON "session_activities" USING btree ("session_id","idx");--> statement-breakpoint
CREATE INDEX "session_activities_session_status_idx" ON "session_activities" USING btree ("session_id","status");--> statement-breakpoint
CREATE INDEX "study_sessions_user_status_idx" ON "study_sessions" USING btree ("user_id","status");