CREATE TABLE "topic_speed" (
	"user_id" uuid NOT NULL,
	"concept_id" text NOT NULL,
	"successes" real NOT NULL,
	"trials" real NOT NULL,
	"answers" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"policy_version" text DEFAULT 'speed-v1' NOT NULL,
	CONSTRAINT "topic_speed_user_id_concept_id_pk" PRIMARY KEY("user_id","concept_id")
);
--> statement-breakpoint
ALTER TABLE "quiz_items" ADD COLUMN "submission" jsonb;--> statement-breakpoint
ALTER TABLE "review_logs" ADD COLUMN "speed" real;--> statement-breakpoint
ALTER TABLE "review_logs" ADD COLUMN "raw_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "topic_speed" ADD CONSTRAINT "topic_speed_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;