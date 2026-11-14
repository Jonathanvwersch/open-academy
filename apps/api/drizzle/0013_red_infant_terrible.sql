ALTER TYPE "public"."diagnostic_kind" ADD VALUE 'placement';--> statement-breakpoint
CREATE TABLE "course_enrollments" (
	"user_id" uuid NOT NULL,
	"course_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"start_method" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "course_enrollments_user_id_course_id_pk" PRIMARY KEY("user_id","course_id"),
	CONSTRAINT "course_enrollments_status_check" CHECK ("course_enrollments"."status" in ('active', 'paused', 'completed')),
	CONSTRAINT "course_enrollments_start_method_check" CHECK ("course_enrollments"."start_method" in ('placement', 'beginning'))
);
--> statement-breakpoint
ALTER TABLE "course_enrollments" ADD CONSTRAINT "course_enrollments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;