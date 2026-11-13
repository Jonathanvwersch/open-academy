DROP TABLE IF EXISTS "tutor_calls";--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_calls_user_created_idx" ON "llm_calls" USING btree ("user_id","created_at");