CREATE TABLE "tutor_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"concept_id" text,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tutor_messages" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "tutor_messages" ADD COLUMN "lesson_problem_id" uuid;--> statement-breakpoint
ALTER TABLE "tutor_threads" ADD CONSTRAINT "tutor_threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tutor_threads_user_updated_idx" ON "tutor_threads" USING btree ("user_id","updated_at");--> statement-breakpoint
ALTER TABLE "tutor_messages" ADD CONSTRAINT "tutor_messages_thread_id_tutor_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."tutor_threads"("id") ON DELETE cascade ON UPDATE no action;