import { execFileSync } from 'node:child_process';
import { createDb } from '../src/server/db/client.js';
import { env } from '../src/server/env.js';

const db = createDb(env.DATABASE_URL);
await db.$client.unsafe(`
  TRUNCATE TABLE
    study_sessions, session_activities, attempts, hint_events, mastery,
    mastery_events, review_cards, review_logs, diagnostic_runs, remediation_flags,
    project_progress, project_submissions, tutor_messages, llm_calls,
    paper_progress, paper_pages, paper_files, users
  RESTART IDENTITY CASCADE
`);
await db.$client.end();
execFileSync('pnpm', ['db:seed'], { stdio: 'inherit' });
