ALTER TYPE "public"."activity_kind" ADD VALUE 'paper';

CREATE TABLE "paper_files" (
  "paper_id" text PRIMARY KEY NOT NULL,
  "bytes" bytea NOT NULL,
  "sha256" text NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "paper_pages" (
  "paper_id" text NOT NULL,
  "page" integer NOT NULL,
  "text" text NOT NULL,
  CONSTRAINT "paper_pages_paper_id_page_pk" PRIMARY KEY("paper_id", "page")
);

CREATE TABLE "paper_progress" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "paper_id" text NOT NULL,
  "last_page" integer DEFAULT 1 NOT NULL,
  "notes" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "summary" text,
  "summary_judgement" jsonb,
  "completed_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "paper_progress_user_id_paper_id_pk" PRIMARY KEY("user_id", "paper_id")
);

CREATE UNIQUE INDEX "paper_progress_user_paper_unique" ON "paper_progress" ("user_id", "paper_id");
