CREATE TABLE "placement_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"concept_id" text NOT NULL,
	"origin" text NOT NULL,
	"state" text NOT NULL,
	"reason" text NOT NULL,
	"evidence_attempt_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmed_by_attempt_id" uuid,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_by_attempt_id" uuid,
	CONSTRAINT "placement_grants_origin_check" CHECK ("placement_grants"."origin" in ('direct', 'inferred')),
	CONSTRAINT "placement_grants_state_check" CHECK ("placement_grants"."state" in ('conditional', 'confirmed', 'withdrawn'))
);
--> statement-breakpoint
ALTER TABLE "placement_grants" ADD CONSTRAINT "placement_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_grants" ADD CONSTRAINT "placement_grants_run_id_diagnostic_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."diagnostic_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_grants" ADD CONSTRAINT "placement_grants_confirmed_by_attempt_id_attempts_id_fk" FOREIGN KEY ("confirmed_by_attempt_id") REFERENCES "public"."attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_grants" ADD CONSTRAINT "placement_grants_withdrawn_by_attempt_id_attempts_id_fk" FOREIGN KEY ("withdrawn_by_attempt_id") REFERENCES "public"."attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "placement_grants_user_run_concept_unique" ON "placement_grants" USING btree ("user_id","run_id","concept_id");--> statement-breakpoint
CREATE INDEX "placement_grants_user_concept_idx" ON "placement_grants" USING btree ("user_id","concept_id");--> statement-breakpoint
INSERT INTO "placement_grants" (
	"user_id", "run_id", "concept_id", "origin", "state", "reason", "evidence_attempt_ids",
	"created_at", "updated_at", "confirmed_at"
)
SELECT
	r."user_id",
	r."id",
	k."concept_id",
	CASE WHEN ev."ids" IS NULL THEN 'inferred' ELSE 'direct' END,
	CASE WHEN m."any_provisional" THEN 'conditional' ELSE 'confirmed' END,
	CASE WHEN m."any_provisional" THEN 'legacy_provisional' ELSE 'legacy_confirmed' END,
	COALESCE(ev."ids", '[]'::jsonb),
	r."completed_at",
	r."completed_at",
	CASE WHEN m."any_provisional" THEN NULL ELSE r."completed_at" END
FROM "diagnostic_runs" r
CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(r."state"->'known', '[]'::jsonb)) AS k("concept_id")
CROSS JOIN LATERAL (
	SELECT
		bool_or(ms."provisional") AS "any_provisional",
		bool_and(ms."state"::text IN ('independent', 'retained')) AS "all_credited"
	FROM "mastery" ms
	WHERE ms."user_id" = r."user_id" AND ms."concept_id" = k."concept_id"
) m
LEFT JOIN LATERAL (
	SELECT jsonb_agg(a."id"::text ORDER BY a."created_at") AS "ids"
	FROM "attempts" a
	WHERE a."user_id" = r."user_id"
		AND a."concept_id" = k."concept_id"
		AND a."mode"::text = 'diagnostic'
		AND a."correct" >= 1
		AND a."created_at" BETWEEN r."started_at" AND r."completed_at"
) ev ON true
WHERE r."kind"::text = 'placement'
	AND r."status"::text = 'completed'
	AND r."completed_at" IS NOT NULL
	AND m."all_credited"
	AND EXISTS (
		SELECT 1 FROM "mastery_events" e
		WHERE e."user_id" = r."user_id"
			AND e."concept_id" = k."concept_id"
			AND e."rule" IN ('placement_placed_out', 'placement_provisional_independent')
	)
	AND NOT EXISTS (
		SELECT 1 FROM "lesson_runs" l
		WHERE l."user_id" = r."user_id" AND l."concept_id" = k."concept_id"
	)
ON CONFLICT DO NOTHING;
