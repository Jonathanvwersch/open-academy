ALTER TABLE "tutor_messages" ADD COLUMN "client_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "tutor_messages_thread_client_unique" ON "tutor_messages" USING btree ("thread_id","client_id");