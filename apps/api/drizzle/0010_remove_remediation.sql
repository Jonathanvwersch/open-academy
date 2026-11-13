UPDATE "remediation_flags"
SET "status" = 'resolved', "resolved_at" = now()
WHERE "status" = 'open';
--> statement-breakpoint
UPDATE "session_activities"
SET "status" = 'skipped'
WHERE "kind" = 'remediate' AND "status" = 'planned';
