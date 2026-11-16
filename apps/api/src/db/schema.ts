import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const sessionKindEnum = pgEnum('session_kind', ['weekday', 'saturday', 'sunday', 'custom']);
export const sessionStatusEnum = pgEnum('session_status', [
  'planned',
  'active',
  'completed',
  'abandoned',
]);
export const activityKindEnum = pgEnum('activity_kind', [
  'review',
  'learn',
  'practice',
  'remediate',
  'quick_check',
  'transfer',
  'lab',
  'reflect',
  'teachback',
  'diagnostic',
  'paper',
]);
export const activityStatusEnum = pgEnum('activity_status', [
  'planned',
  'in_progress',
  'completed',
  'skipped',
]);
export const attemptModeEnum = pgEnum('attempt_mode', [
  'practice',
  'assessment',
  'diagnostic',
  'review',
]);
export const hintSourceEnum = pgEnum('hint_source', ['authored', 'llm']);
export const masteryStateEnum = pgEnum('mastery_state', [
  'not_assessed',
  'introduced',
  'assisted',
  'independent',
  'retained',
]);
export const diagnosticKindEnum = pgEnum('diagnostic_kind', [
  'baseline',
  'day30',
  'day60',
  'day90',
  'placement',
]);
export const diagnosticStatusEnum = pgEnum('diagnostic_status', [
  'active',
  'completed',
  'abandoned',
]);
export const remediationStatusEnum = pgEnum('remediation_status', ['open', 'resolved']);
export const projectStatusEnum = pgEnum('project_status', [
  'not_started',
  'in_progress',
  'completed',
]);
export const lessonRunStatusEnum = pgEnum('lesson_run_status', [
  'in_progress',
  'needs_retry',
  'quiz',
  'completed',
]);
export const xpEventKindEnum = pgEnum('xp_event_kind', [
  'activity',
  'knowledge_point',
  'review',
  'quiz',
  'project',
]);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  displayName: text('display_name').notNull(),
  timezone: text('timezone').notNull().default('Europe/London'),
  startDate: text('start_date').notNull().default(''),
  prefs: jsonb('prefs').notNull().default({}),
  activeCourseId: text('active_course_id'),
  studySetInitializedAt: timestamp('study_set_initialized_at', {
    withTimezone: true,
    mode: 'date',
  }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const studySessions = pgTable(
  'study_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: sessionKindEnum('kind').notNull().default('weekday'),
    plannedMinutes: integer('planned_minutes').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
    status: sessionStatusEnum('status').notNull().default('planned'),
    plan: jsonb('plan').notNull().default({}),
    activeSeconds: integer('active_seconds').notNull().default(0),
  },
  (table) => [index('study_sessions_user_status_idx').on(table.userId, table.status)],
);

export const sessionActivities = pgTable(
  'session_activities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => studySessions.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    kind: activityKindEnum('kind').notNull(),
    conceptId: text('concept_id'),
    projectId: text('project_id'),
    exerciseIds: jsonb('exercise_ids').$type<string[]>().notNull().default([]),
    plannedMinutes: integer('planned_minutes').notNull(),
    status: activityStatusEnum('status').notNull().default('planned'),
    progress: jsonb('progress').notNull().default({}),
    reason: jsonb('reason').notNull().default({}),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('session_activities_session_idx_unique').on(table.sessionId, table.idx),
    index('session_activities_session_status_idx').on(table.sessionId, table.status),
  ],
);

export const attempts = pgTable(
  'attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => studySessions.id, { onDelete: 'set null' }),
    activityId: uuid('activity_id').references(() => sessionActivities.id, {
      onDelete: 'set null',
    }),
    exerciseId: text('exercise_id').notNull(),
    exerciseVersion: text('exercise_version').notNull(),
    conceptId: text('concept_id').notNull(),
    dimension: text('dimension').notNull(),
    mode: attemptModeEnum('mode').notNull(),
    answer: jsonb('answer').notNull(),
    correct: real('correct').notNull(),
    credit: real('credit').notNull(),
    hintsUsed: integer('hints_used').notNull().default(0),
    attemptNo: integer('attempt_no').notNull().default(1),
    gradedBy: text('graded_by').notNull(),
    feedback: jsonb('feedback').notNull().default({}),
    mistakeCategory: text('mistake_category'),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('attempts_user_concept_created_idx').on(table.userId, table.conceptId, table.createdAt),
    index('attempts_activity_exercise_idx').on(table.activityId, table.exerciseId, table.attemptNo),
  ],
);

export const lessonRuns = pgTable(
  'lesson_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conceptId: text('concept_id').notNull(),
    status: lessonRunStatusEnum('status').notNull().default('in_progress'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    quizPassedAt: timestamp('quiz_passed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('lesson_runs_user_concept_unique').on(table.userId, table.conceptId),
    index('lesson_runs_user_status_idx').on(table.userId, table.status),
  ],
);

export const lessonProblems = pgTable(
  'lesson_problems',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => lessonRuns.id, { onDelete: 'cascade' }),
    knowledgePointId: text('knowledge_point_id').notNull(),
    round: integer('round').notNull(),
    position: integer('position').notNull(),
    exerciseId: text('exercise_id').notNull(),
    seed: integer('seed'),
    practiceOnly: boolean('practice_only').notNull().default(false),
    assisted: boolean('assisted').notNull().default(false),
    servedAt: timestamp('served_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    answeredAt: timestamp('answered_at', { withTimezone: true, mode: 'date' }),
    correct: real('correct'),
    attemptId: uuid('attempt_id').references(() => attempts.id, { onDelete: 'set null' }),
  },
  (table) => [
    uniqueIndex('lesson_problems_run_point_round_position_unique').on(
      table.runId,
      table.knowledgePointId,
      table.round,
      table.position,
    ),
    index('lesson_problems_run_point_idx').on(table.runId, table.knowledgePointId, table.round),
  ],
);

export const lessonQuizAttempts = pgTable(
  'lesson_quiz_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => lessonRuns.id, { onDelete: 'cascade' }),
    attemptNo: integer('attempt_no').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }),
    score: real('score'),
    passed: boolean('passed'),
  },
  (table) => [
    check(
      'lesson_quiz_attempts_score_range',
      sql`${table.score} IS NULL OR (${table.score} >= 0 AND ${table.score} <= 1)`,
    ),
    uniqueIndex('lesson_quiz_attempts_run_attempt_unique').on(table.runId, table.attemptNo),
  ],
);

export const lessonQuizItems = pgTable(
  'lesson_quiz_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    quizAttemptId: uuid('quiz_attempt_id')
      .notNull()
      .references(() => lessonQuizAttempts.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    knowledgePointId: text('knowledge_point_id').notNull(),
    exerciseId: text('exercise_id').notNull(),
    seed: integer('seed'),
    answer: jsonb('answer'),
    correct: real('correct'),
    durationMs: integer('duration_ms'),
    attemptId: uuid('attempt_id').references(() => attempts.id, { onDelete: 'set null' }),
    answeredAt: timestamp('answered_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('lesson_quiz_items_attempt_position_unique').on(
      table.quizAttemptId,
      table.position,
    ),
  ],
);

export const xpEvents = pgTable(
  'xp_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: xpEventKindEnum('kind').notNull(),
    sourceKey: text('source_key').notNull(),
    conceptId: text('concept_id'),
    amount: integer('amount').notNull(),
    earnedAt: timestamp('earned_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    localDate: text('local_date').notNull(),
  },
  (table) => [
    uniqueIndex('xp_events_user_source_unique').on(table.userId, table.sourceKey),
    index('xp_events_user_local_date_idx').on(table.userId, table.localDate),
  ],
);

export const hintEvents = pgTable(
  'hint_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    activityId: uuid('activity_id').references(() => sessionActivities.id, {
      onDelete: 'set null',
    }),
    exerciseId: text('exercise_id').notNull(),
    level: integer('level').notNull(),
    source: hintSourceEnum('source').notNull().default('authored'),
    text: text('text').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('hint_events_activity_exercise_idx').on(table.activityId, table.exerciseId)],
);

export const mastery = pgTable(
  'mastery',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conceptId: text('concept_id').notNull(),
    dimension: text('dimension').notNull(),
    state: masteryStateEnum('state').notNull().default('not_assessed'),
    provisional: boolean('provisional').notNull().default(false),
    inferred: boolean('inferred').notNull().default(false),
    evidence: jsonb('evidence').notNull().default({}),
    lastAssessedAt: timestamp('last_assessed_at', { withTimezone: true, mode: 'date' }),
    lastIndependentAt: timestamp('last_independent_at', { withTimezone: true, mode: 'date' }),
    firstIndependentAt: timestamp('first_independent_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.conceptId, table.dimension] }),
    index('mastery_user_state_idx').on(table.userId, table.state),
  ],
);

export const masteryEvents = pgTable(
  'mastery_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conceptId: text('concept_id').notNull(),
    dimension: text('dimension').notNull(),
    fromState: masteryStateEnum('from_state').notNull(),
    toState: masteryStateEnum('to_state').notNull(),
    rule: text('rule').notNull(),
    attemptId: uuid('attempt_id').references(() => attempts.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('mastery_events_user_concept_created_idx').on(
      table.userId,
      table.conceptId,
      table.createdAt,
    ),
  ],
);

export const reviewCards = pgTable(
  'review_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conceptId: text('concept_id').notNull(),
    dimension: text('dimension').notNull(),
    fsrs: jsonb('fsrs').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true, mode: 'date' }).notNull(),
    lastReviewAt: timestamp('last_review_at', { withTimezone: true, mode: 'date' }),
    reps: integer('reps').notNull().default(0),
    lapses: integer('lapses').notNull().default(0),
  },
  (table) => [
    uniqueIndex('review_cards_user_concept_dimension_unique').on(
      table.userId,
      table.conceptId,
      table.dimension,
    ),
    index('review_cards_user_due_idx').on(table.userId, table.dueAt),
  ],
);

export const reviewLogs = pgTable('review_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  cardId: uuid('card_id')
    .notNull()
    .references(() => reviewCards.id, { onDelete: 'cascade' }),
  attemptId: uuid('attempt_id').references(() => attempts.id, { onDelete: 'set null' }),
  rating: text('rating').notNull(),
  fsrsLog: jsonb('fsrs_log').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const diagnosticRuns = pgTable(
  'diagnostic_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: diagnosticKindEnum('kind').notNull().default('baseline'),
    status: diagnosticStatusEnum('status').notNull().default('active'),
    state: jsonb('state').notNull().default({}),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    summary: jsonb('summary').notNull().default({}),
  },
  (table) => [index('diagnostic_runs_user_status_idx').on(table.userId, table.status)],
);

export const courseEnrollments = pgTable(
  'course_enrollments',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    courseId: text('course_id').notNull(),
    status: text('status').$type<'active' | 'paused' | 'completed'>().notNull().default('active'),
    startMethod: text('start_method').$type<'placement' | 'beginning'>().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.courseId] }),
    check(
      'course_enrollments_status_check',
      sql`${table.status} in ('active', 'paused', 'completed')`,
    ),
    check(
      'course_enrollments_start_method_check',
      sql`${table.startMethod} in ('placement', 'beginning')`,
    ),
  ],
);

export const remediationFlags = pgTable(
  'remediation_flags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conceptId: text('concept_id').notNull(),
    targetPrereqId: text('target_prereq_id'),
    status: remediationStatusEnum('status').notNull().default('open'),
    openedByAttemptId: uuid('opened_by_attempt_id').references(() => attempts.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [index('remediation_flags_user_status_idx').on(table.userId, table.status)],
);

export const projectProgress = pgTable(
  'project_progress',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull(),
    status: projectStatusEnum('status').notNull().default('not_started'),
    taskState: jsonb('task_state').notNull().default({}),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.projectId] })],
);

export const projectSubmissions = pgTable('project_submissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull(),
  results: jsonb('results').notNull(),
  passed: integer('passed').notNull(),
  total: integer('total').notNull(),
  metrics: jsonb('metrics').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const tutorThreads = pgTable(
  'tutor_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conceptId: text('concept_id'),
    title: text('title').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('tutor_threads_user_updated_idx').on(table.userId, table.updatedAt)],
);

export const tutorMessages = pgTable('tutor_messages', {
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  activityId: uuid('activity_id').references(() => sessionActivities.id, { onDelete: 'set null' }),
  threadId: uuid('thread_id').references(() => tutorThreads.id, { onDelete: 'cascade' }),
  exerciseId: text('exercise_id'),
  lessonProblemId: uuid('lesson_problem_id'),
  role: text('role').notNull(),
  content: text('content').notNull(),
  llmCallId: uuid('llm_call_id'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const llmCalls = pgTable(
  'llm_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    promptId: text('prompt_id').notNull(),
    promptVersion: text('prompt_version').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: real('cost_usd'),
    latencyMs: integer('latency_ms'),
    status: text('status').notNull(),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('llm_calls_user_created_idx').on(table.userId, table.createdAt)],
);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

export const paperFiles = pgTable('paper_files', {
  paperId: text('paper_id').primaryKey(),
  bytes: bytea('bytes').notNull(),
  sha256: text('sha256').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const paperPages = pgTable(
  'paper_pages',
  {
    paperId: text('paper_id').notNull(),
    page: integer('page').notNull(),
    text: text('text').notNull(),
  },
  (table) => [primaryKey({ columns: [table.paperId, table.page] })],
);

export const paperProgress = pgTable(
  'paper_progress',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    paperId: text('paper_id').notNull(),
    lastPage: integer('last_page').notNull().default(1),
    notes: jsonb('notes').$type<Record<string, string>>().notNull().default({}),
    summary: text('summary'),
    summaryJudgement: jsonb('summary_judgement').$type<
      import('../features/tutor/schemas.js').RubricJudgement | null
    >(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.paperId] }),
    uniqueIndex('paper_progress_user_paper_unique').on(table.userId, table.paperId),
  ],
);

export const authSessions = pgTable('auth_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }),
});
