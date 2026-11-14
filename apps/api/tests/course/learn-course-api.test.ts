import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config.js';
import { loadContent } from '../../src/content/load.js';
import type { ContentIndex } from '../../src/content/types.js';
import { createDb } from '../../src/db/client.js';
import {
  attempts,
  lessonProblems,
  lessonRuns,
  mastery,
  paperProgress,
  projectProgress,
  sessionActivities,
  studySessions,
  users,
  xpEvents,
} from '../../src/db/schema.js';
import { prerequisiteMet } from '../../src/learning/prerequisites.js';
import type { MasteryRecord } from '../../src/learning/types.js';

const db = createDb(env.TEST_DATABASE_URL);
const userId = '00000000-0000-4000-8000-000000000092';
let app: ReturnType<typeof createApp>;
let content: ContentIndex;

beforeAll(async () => {
  content = await loadContent();
  app = createApp({ db, content, tutorProvider: null });
});

beforeEach(async () => {
  await db.delete(users);
  await db.insert(users).values({
    id: userId,
    displayName: 'Learn course API learner',
    timezone: 'UTC',
    startDate: '2026-01-01',
    prefs: { scheduleMinutes: 60 },
  });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
  await db.$client.end();
});

async function rowCounts() {
  const sessions = await db.select().from(studySessions).where(eq(studySessions.userId, userId));
  const [activityRows, attemptRows, runRows, masteryRows, xpRows] = await Promise.all([
    sessions.length
      ? db
          .select()
          .from(sessionActivities)
          .where(eq(sessionActivities.sessionId, sessions[0]?.id ?? ''))
      : Promise.resolve([]),
    db.select().from(attempts).where(eq(attempts.userId, userId)),
    db.select().from(lessonRuns).where(eq(lessonRuns.userId, userId)),
    db.select().from(mastery).where(eq(mastery.userId, userId)),
    db.select().from(xpEvents).where(eq(xpEvents.userId, userId)),
  ]);
  const problems = runRows.length
    ? await db
        .select()
        .from(lessonProblems)
        .where(eq(lessonProblems.runId, runRows[0]?.id ?? ''))
    : [];
  return {
    sessions: sessions.length,
    activities: activityRows.length,
    attempts: attemptRows.length,
    runs: runRows.length,
    problems: problems.length,
    mastery: masteryRows.length,
    xp: xpRows.length,
  };
}

async function get(path: string) {
  return app.request(`/api${path}`, {
    headers: { 'X-Now': '2026-01-07T12:00:00.000Z' },
  });
}

async function put(path: string, body: unknown) {
  return app.request(`/api${path}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Now': '2026-01-07T12:00:00.000Z',
    },
    body: JSON.stringify(body),
  });
}

test('learners can switch to a listed course', async () => {
  const response = await put('/course/active', { courseId: 'robotics' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ courseId: 'robotics' });
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  expect(user?.activeCourseId).toBe('robotics');
  const coursePayload = await (await get('/course')).json();
  expect(coursePayload.course).toMatchObject({ id: 'robotics', title: 'Robotics' });
  expect(
    coursePayload.courses.find((course: { id: string }) => course.id === 'robotics'),
  ).toMatchObject({
    active: true,
    topicsTotal: expect.any(Number),
  });
  const learnPayload = await (await get('/learn')).json();
  expect(learnPayload.streak).toMatchObject({
    current: expect.any(Number),
    longest: expect.any(Number),
    todayComplete: expect.any(Boolean),
    days: expect.any(Array),
  });
  expect(learnPayload.streak.days).toHaveLength(7);
  expect(learnPayload.course).toMatchObject({
    title: 'Robotics',
    topicsTotal: coursePayload.units.reduce(
      (total: number, unit: { topics: unknown[] }) => total + unit.topics.length,
      0,
    ),
  });
});

test('switching to an unknown course returns 404 without changing learner state', async () => {
  const response = await put('/course/active', { courseId: 'missing-course' });
  expect(response.status).toBe(404);
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  expect(user?.activeCourseId).toBeNull();
});

test('course outlines list shared-course dependents once', async () => {
  const fixtureContent = await loadContent('tests/fixtures/content');
  const fixtureApp = createApp({ db, content: fixtureContent, tutorProvider: null });
  const response = await fixtureApp.request('/api/course', {
    headers: { 'X-Now': '2026-01-07T12:00:00.000Z' },
  });
  expect(response.status).toBe(200);
  expect(
    fixtureContent.courses.filter((course) =>
      course.units.some((unit) => unit.concepts.includes('linear-models')),
    ),
  ).toHaveLength(2);
  const coursePayload = (await response.json()) as {
    units: Array<{
      topics: Array<{
        conceptId: string;
        leadsTo: Array<{ id: string }>;
        leadsToMore: number;
      }>;
    }>;
  };
  const topics = coursePayload.units.flatMap((unit) => unit.topics);
  const vectorDependents = [
    ...new Set(
      fixtureContent.courses
        .flatMap((course) => course.units.flatMap((unit) => unit.concepts))
        .filter((conceptId) =>
          fixtureContent.conceptsById
            .get(conceptId)
            ?.prereqs.some((prerequisite) => prerequisite.id === 'vectors'),
        ),
    ),
  ];
  const vectors = topics.find((topic) => topic.conceptId === 'vectors');
  expect(vectors?.leadsTo.map(({ id }) => id)).toEqual(vectorDependents.slice(0, 3));
  expect(vectors?.leadsToMore).toBe(Math.max(0, vectorDependents.length - 3));

  const supervisedLearning = topics.find((topic) => topic.conceptId === 'supervised-learning');
  expect(supervisedLearning?.leadsTo.map(({ id }) => id)).toEqual(['linear-models']);
  expect(supervisedLearning?.leadsToMore).toBe(0);
});

test('paper completion changes only its reading status, not learner progress', async () => {
  const defaultCourse = content.coursesById.get(content.curriculum?.default_course ?? '');
  const paperId = defaultCourse?.units.flatMap((unit) => unit.papers ?? [])[0];
  const paper = paperId ? content.papersById.get(paperId) : undefined;
  if (!paper) throw new Error('Expected paper content');

  const beforeLearn = await (await get('/learn')).json();
  const beforeCourse = (await (await get('/course')).json()) as {
    currentUnit: number;
    units: Array<{
      papers: Array<{ id: string; status: string }>;
      topics: Array<{ conceptId: string; status: string }>;
    }>;
  };
  const now = new Date('2026-01-07T12:00:00.000Z');
  await db.insert(paperProgress).values({
    userId,
    paperId: paper.id,
    completedAt: now,
    updatedAt: now,
  });
  const afterLearn = await (await get('/learn')).json();
  const afterCourse = (await (await get('/course')).json()) as typeof beforeCourse;
  const paperStatus = (course: typeof beforeCourse) =>
    course.units
      .flatMap((unit) => unit.papers)
      .find((entry: { id: string }) => entry.id === paper.id)?.status;
  const topicProgress = (course: typeof beforeCourse) =>
    course.units.flatMap((unit) =>
      unit.topics.map((topic: { conceptId: string; status: string }) => [
        topic.conceptId,
        topic.status,
      ]),
    );

  expect(paperStatus(beforeCourse)).toBe('not_started');
  expect(paperStatus(afterCourse)).toBe('completed');
  expect(afterLearn.xp).toEqual(beforeLearn.xp);
  expect(afterLearn.course).toEqual(beforeLearn.course);
  expect(afterCourse.currentUnit).toBe(beforeCourse.currentUnit);
  expect(topicProgress(afterCourse)).toEqual(topicProgress(beforeCourse));
});

const nnFromScratchTestIds = [
  'test_data_is_seeded_and_split',
  'test_parameter_forward_and_gradient_shapes',
  'test_forward_matches_reference',
  'test_loss_matches_mean_binary_cross_entropy',
  'test_gradients_match_numerical_differences',
  'test_training_step_lowers_loss',
  'test_training_reaches_validation_accuracy',
  'test_hidden_layer_beats_linear_baseline',
];

const nnFromScratchPassingMetrics = {
  final_train_loss: 0.05,
  validation_accuracy: 0.95,
  max_gradient_check_relative_error: 0.000001,
};

function nnFromScratchResults(
  tests = nnFromScratchTestIds.map((id) => ({ id, passed: true, message: 'passed' })),
  metrics = nnFromScratchPassingMetrics,
) {
  return {
    project: 'nn-from-scratch',
    version: 1,
    tests,
    metrics,
    generated_at: '2026-11-14T12:00:00.000Z',
  };
}

test('lesson response includes ordered authored prerequisites', async () => {
  const response = await get('/lessons/gradient-descent');
  expect(response.status).toBe(200);
  expect((await response.json()).prerequisites).toMatchObject([
    {
      id: 'gradients',
      title: 'Gradient vectors',
      recap: expect.stringContaining('The gradient'),
    },
    {
      id: 'loss-functions',
      title: 'Loss functions (MSE, MAE)',
      recap: expect.stringContaining('A loss is one number'),
    },
    {
      id: 'linear-regression',
      title: 'Linear regression',
      recap: expect.stringContaining('A linear model predicts'),
    },
  ]);
});

test('planned Learn tasks and Course numbering are read-only', async () => {
  const before = await rowCounts();
  const learnResponse = await get('/learn');
  expect(learnResponse.status).toBe(200);
  const learn = await learnResponse.json();
  expect(learn.activeSessionId).toBeNull();
  expect(learn.tasks.length).toBeGreaterThan(0);
  expect(learn.tasks[0]).toMatchObject({
    id: expect.any(String),
    label: expect.stringMatching(/^(Lesson|Review|Practice|Project|Quiz)$/),
    title: expect.any(String),
    xp: expect.any(Number),
    prerequisites: expect.any(Array),
  });
  expect(new Set(learn.tasks.map((task: { id: string }) => task.id)).size).toBe(learn.tasks.length);
  expect(learn.course).toMatchObject({
    percentComplete: expect.any(Number),
    topicsDone: expect.any(Number),
    topicsTotal: expect.any(Number),
    estimatedFinish: expect.any(String),
    estimatedFinishAtGoal: expect.any(String),
  });

  const courseResponse = await get('/course');
  expect(courseResponse.status).toBe(200);
  const course: {
    course: { id: string; title: string; description: string };
    courses: Array<{
      id: string;
      title: string;
      description: string;
      topicsDone: number;
      topicsTotal: number;
      active: boolean;
    }>;
    currentUnit: number;
    foundations: Array<{ number: string; conceptId: string; title: string }>;
    units: Array<{
      unit: number;
      title: string;
      intro: string;
      project: {
        id: string;
        title: string;
        available: boolean;
        status: 'not_started' | 'in_progress' | 'completed';
      } | null;
      topics: Array<{
        number: string;
        conceptId: string;
        title: string;
        hasLesson: boolean;
        status: string;
        mastery: string;
        needs?: Array<{ id: string; title: string }>;
        buildsOn: Array<{ id: string; title: string }>;
        leadsTo: Array<{ id: string; title: string }>;
        leadsToMore: number;
      }>;
    }>;
  } = await courseResponse.json();
  expect(course.course).toMatchObject({
    id: 'ml-foundations',
    title: 'Machine Learning Foundations',
    description: expect.any(String),
  });
  expect(course.courses.find((entry) => entry.id === course.course.id)).toMatchObject({
    active: true,
    topicsDone: 0,
    topicsTotal: expect.any(Number),
  });
  expect(course.currentUnit).toBe(1);
  expect(course.foundations).toEqual(expect.any(Array));
  expect(course.courses.some((entry) => entry.active)).toBe(true);
  expect(course.units[0].topics[0]).toMatchObject({
    number: '1.1',
    conceptId: 'what-is-ml',
    title: 'What machine learning is, and how this course fits together',
    status: expect.stringMatching(/^(locked|not_started|in_progress|complete)$/),
    mastery: 'Not started',
  });
  expect(course.units[0]).toMatchObject({
    intro:
      "You'll build the simplest model that learns: predicting a house's price from its measurements, trained on past sales. The maths topics are the tools this model needs, taught in the order it needs them.",
    project: {
      id: 'linreg-numpy',
      title: expect.any(String),
      available: true,
      status: 'not_started',
    },
  });
  expect(
    course.units[0].topics.find((topic) => topic.conceptId === 'supervised-learning'),
  ).toMatchObject({
    buildsOn: [
      {
        id: 'what-is-ml',
        title: 'What machine learning is, and how this course fits together',
      },
    ],
    leadsTo: expect.arrayContaining([expect.objectContaining({ id: 'linear-regression' })]),
    leadsToMore: expect.any(Number),
  });
  const dotProduct = course.units
    .flatMap((unit) => unit.topics)
    .find((topic) => topic.conceptId === 'dot-product');
  expect(dotProduct).toMatchObject({
    needs: [{ id: 'vectors', title: 'Vectors and vector operations' }],
  });
  const masteryByKey = new Map<string, Pick<MasteryRecord, 'state' | 'inferred'>>();
  const lessonRuns: Array<{
    conceptId: string;
    status: 'in_progress' | 'needs_retry' | 'completed';
  }> = [];
  for (const topic of course.units.flatMap((unit) => unit.topics)) {
    const concept = content.conceptsById.get(topic.conceptId);
    const locked = Boolean(
      concept?.prereqs.some(
        (prerequisite) =>
          prerequisite.strength === 'hard' &&
          !prerequisiteMet(prerequisite.id, masteryByKey, lessonRuns, content),
      ),
    );
    expect(topic.status === 'locked').toBe(locked);
  }
  expect(await rowCounts()).toEqual(before);
});

test('session creation matches the local-day preview kind and activities', async () => {
  for (const [now, expectedKind] of [
    ['2026-11-14T12:00:00.000Z', 'saturday'],
    ['2026-11-15T12:00:00.000Z', 'sunday'],
    ['2026-11-16T12:00:00.000Z', 'weekday'],
  ] as const) {
    const headers = { 'X-Now': now, 'X-Time-Zone': 'UTC' };
    const previewResponse = await app.request('/api/today', { headers });
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    expect(preview.sessionKind).toBe(expectedKind);
    const home = await (await app.request('/api/learn', { headers })).json();
    expect(home.today).toMatchObject({
      needsCourseChoice: preview.needsCourseChoice,
      courseStart: preview.courseStart,
      sessionKind: preview.sessionKind,
    });

    const createdResponse = await app.request('/api/sessions', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    expect(created.kind).toBe(preview.sessionKind);
    expect(created.activities.map((activity: { kind: string }) => activity.kind)).toEqual(
      preview.plan.activities.map((activity: { kind: string }) => activity.kind),
    );
  }
});

test('lesson choices exclude locked, completed and stub concepts and retain the recommended lesson past five', async () => {
  const outlineIds = Array.from(
    new Set(content.courses.flatMap((course) => course.units.flatMap((unit) => unit.concepts))),
  );
  const initial = await (await get('/learn')).json();
  expect(initial.choices.map((choice: { conceptId: string }) => choice.conceptId)).not.toContain(
    'dot-product',
  );
  const stubConceptId = outlineIds.find(
    (conceptId) => content.conceptsById.get(conceptId)?.status === 'stub',
  );
  if (!stubConceptId) throw new Error('Expected a stub concept in the course outline');
  expect(initial.choices.map((choice: { conceptId: string }) => choice.conceptId)).not.toContain(
    stubConceptId,
  );

  const targets: typeof content.concepts = [];
  for (const conceptId of outlineIds) {
    const concept = content.conceptsById.get(conceptId);
    const lesson = content.lessonsByConcept.get(conceptId);
    if (
      concept?.status !== 'authored' ||
      !lesson?.knowledge_points?.length ||
      concept.prereqs.some((prerequisite) =>
        targets.some((target) => target.id === prerequisite.id),
      ) ||
      targets.some((target) => target.prereqs.some((prerequisite) => prerequisite.id === conceptId))
    ) {
      continue;
    }
    targets.push(concept);
    if (targets.length === 6) break;
  }
  if (targets.length !== 6) throw new Error('Expected six independent authored lessons');
  const targetIds = new Set(targets.map((concept) => concept.id));
  await db
    .update(users)
    .set({ prefs: { scheduleMinutes: 600 } })
    .where(eq(users.id, userId));
  await db.insert(lessonRuns).values(
    content.concepts
      .filter((concept) => !targetIds.has(concept.id))
      .map((concept) => ({
        userId,
        conceptId: concept.id,
        status: 'completed' as const,
        completedAt: new Date('2026-01-07T11:00:00.000Z'),
      })),
  );
  const recommendedConcept = targets[5];
  if (!recommendedConcept) throw new Error('Expected a sixth lesson target');
  await db.insert(lessonRuns).values({
    userId,
    conceptId: recommendedConcept.id,
    status: 'in_progress',
  });

  const learn = await (await get('/learn')).json();
  const recommendedConceptId = learn.tasks.find(
    (task: { activityKind: string; conceptId?: string }) => task.activityKind === 'learn',
  )?.conceptId;
  expect(recommendedConceptId).toBe(recommendedConcept.id);
  expect(learn.choices.map((choice: { conceptId: string }) => choice.conceptId)).toEqual([
    ...targets.slice(0, 5).map((concept) => concept.id),
    recommendedConcept.id,
  ]);
  expect(learn.choices).toHaveLength(6);
  expect(learn.choices[5]).toMatchObject({
    conceptId: recommendedConcept.id,
    recommended: true,
  });
  expect(
    learn.choices.slice(0, 5).every((choice: { recommended: boolean }) => !choice.recommended),
  ).toBe(true);
  expect(learn.choices.map((choice: { conceptId: string }) => choice.conceptId)).not.toContain(
    'dot-product',
  );
  expect(learn.choices[0]?.xp).toBe(
    (content.lessonsByConcept.get(targets[0]?.id ?? '')?.knowledge_points?.length ?? 0) * 10,
  );
});

test('lesson choices are empty while a session is active', async () => {
  const started = await app.request('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-01-07T12:00:00.000Z' },
    body: JSON.stringify({ budgetMinutes: 60 }),
  });
  expect(started.status).toBe(201);
  const response = await get('/learn');
  expect((await response.json()).choices).toEqual([]);
});

test('a focused session replaces the default new lesson and rejects locked concepts', async () => {
  const learnResponse = await get('/learn');
  const learn = await learnResponse.json();
  const focusedChoice = learn.choices.find(
    (choice: { recommended: boolean }) => !choice.recommended,
  );
  if (!focusedChoice) throw new Error('Expected a non-recommended lesson choice');
  const response = await app.request('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-01-07T12:00:00.000Z' },
    body: JSON.stringify({ budgetMinutes: 60, focusConceptId: focusedChoice.conceptId }),
  });
  expect(response.status).toBe(201);
  const session = await response.json();
  const learnActivities = session.activities.filter(
    (activity: { kind: string }) => activity.kind === 'learn',
  );
  expect(learnActivities.map((activity: { conceptId: string }) => activity.conceptId)).toEqual([
    focusedChoice.conceptId,
  ]);
  const recommendedConceptId = learn.tasks.find(
    (task: { activityKind: string; conceptId?: string }) => task.activityKind === 'learn',
  )?.conceptId;
  expect(
    learnActivities.map((activity: { conceptId: string }) => activity.conceptId),
  ).not.toContain(recommendedConceptId);

  const locked = await app.request('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': '2026-01-07T12:00:00.000Z' },
    body: JSON.stringify({ focusConceptId: 'dot-product' }),
  });
  expect(locked.status).toBe(409);
  expect(await locked.json()).toEqual({ error: 'Finish Vectors and vector operations first' });
});

test('Course project status reflects the learner project-progress row', async () => {
  await db.insert(projectProgress).values({
    userId,
    projectId: 'linreg-numpy',
    status: 'in_progress',
  });

  const response = await get('/course');
  expect(response.status).toBe(200);
  const course = await response.json();
  expect(course.currentUnit).toBe(1);
  expect(course.units[0].project).toMatchObject({
    id: 'linreg-numpy',
    available: true,
    status: 'in_progress',
  });
});

test('empty project evidence and out-of-range metrics cannot complete a project', async () => {
  const results = {
    project: 'linreg-numpy',
    version: 1,
    tests: [],
    metrics: { val_mse: 999, weight_error: 999 },
    generated_at: '2026-11-14T12:00:00.000Z',
  };
  const submissionResponse = await app.request('/api/projects/linreg-numpy/results', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': results.generated_at },
    body: JSON.stringify(results),
  });
  expect(submissionResponse.status).toBe(201);
  const submission = await submissionResponse.json();
  expect(submission.evidence).toContain('No verifier tests were reported');
  expect(submission.evidence).toContain('Validation MSE');
  expect(submission.evidence).toContain('Max |w - w_true|');

  const projectResponse = await get('/projects/linreg-numpy');
  expect(projectResponse.status).toBe(200);
  const project = await projectResponse.json();
  expect(project.status).toBe('in_progress');
  expect(project.latestSubmission.results).toMatchObject({
    tests: [],
    metrics: results.metrics,
  });

  const failingMetricResponse = await app.request('/api/projects/linreg-numpy/results', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': results.generated_at },
    body: JSON.stringify({
      ...results,
      tests: [{ id: 'test_predict_shape_and_values', passed: true, message: 'passed' }],
    }),
  });
  expect(failingMetricResponse.status).toBe(201);
  expect((await failingMetricResponse.json()).evidence).toContain('Validation MSE');
  const failedMetricProject = await (await get('/projects/linreg-numpy')).json();
  expect(failedMetricProject.status).toBe('in_progress');
});

test('project evidence requires every declared verifier test', async () => {
  const results = nnFromScratchResults([
    {
      id: nnFromScratchTestIds[0] ?? '',
      passed: true,
      message: 'passed',
    },
  ]);
  const response = await app.request('/api/projects/nn-from-scratch/results', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': results.generated_at },
    body: JSON.stringify(results),
  });

  expect(response.status).toBe(201);
  const submission = await response.json();
  expect(submission.evidence).toContain('1/8 checks passed');
  expect(submission.evidence).toContain('Missing:');
  for (const missingTestId of nnFromScratchTestIds.slice(1)) {
    expect(submission.evidence).toContain(missingTestId);
  }

  const project = await (await get('/projects/nn-from-scratch')).json();
  expect(project.status).toBe('in_progress');
});

test('all verifier tests still require every project metric to pass', async () => {
  const results = nnFromScratchResults(undefined, {
    ...nnFromScratchPassingMetrics,
    validation_accuracy: 0.89,
  });
  const response = await app.request('/api/projects/nn-from-scratch/results', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': results.generated_at },
    body: JSON.stringify(results),
  });

  expect(response.status).toBe(201);
  expect((await response.json()).evidence).toContain('8/8 checks passed');
  const project = await (await get('/projects/nn-from-scratch')).json();
  expect(project.status).toBe('in_progress');
});

test('all verifier tests and metrics complete the project', async () => {
  const results = nnFromScratchResults();
  const response = await app.request('/api/projects/nn-from-scratch/results', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': results.generated_at },
    body: JSON.stringify(results),
  });

  expect(response.status).toBe(201);
  expect((await response.json()).evidence).toContain('8/8 checks passed');
  const project = await (await get('/projects/nn-from-scratch')).json();
  expect(project.status).toBe('completed');
});

test('unknown project verifier test IDs are rejected with 422', async () => {
  const results = nnFromScratchResults([{ id: 'test_unknown', passed: true, message: 'passed' }]);
  const response = await app.request('/api/projects/nn-from-scratch/results', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Now': results.generated_at },
    body: JSON.stringify(results),
  });

  expect(response.status).toBe(422);
});

test('active-session tasks, done-today activity, and local-date KP XP are returned read-only', async () => {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 30,
      status: 'active',
      startedAt: new Date('2026-01-07T11:00:00.000Z'),
    })
    .returning();
  if (!session) throw new Error('Could not create Learn fixture session');
  const [completed, remaining] = await db
    .insert(sessionActivities)
    .values([
      {
        sessionId: session.id,
        idx: 0,
        kind: 'practice',
        conceptId: 'vectors',
        exerciseIds: ['vec-points-moves-basics'],
        plannedMinutes: 12,
        status: 'completed',
        completedAt: new Date('2026-01-07T11:30:00.000Z'),
      },
      {
        sessionId: session.id,
        idx: 1,
        kind: 'learn',
        conceptId: 'supervised-learning',
        plannedMinutes: 18,
        status: 'in_progress',
      },
    ])
    .returning();
  if (!completed || !remaining) throw new Error('Could not create Learn fixture activities');
  const [run] = await db
    .insert(lessonRuns)
    .values({
      userId,
      conceptId: 'supervised-learning',
      status: 'in_progress',
      startedAt: new Date('2026-01-07T11:00:00.000Z'),
    })
    .returning();
  if (!run) throw new Error('Could not create active lesson run');
  await db.insert(xpEvents).values([
    {
      userId,
      kind: 'knowledge_point',
      sourceKey: `kp:${run.id}:point`,
      conceptId: 'supervised-learning',
      amount: 10,
      earnedAt: new Date('2026-01-07T11:15:00.000Z'),
      localDate: '2026-01-07',
    },
    {
      userId,
      kind: 'activity',
      sourceKey: `activity:${completed.id}`,
      conceptId: 'vectors',
      amount: 12,
      earnedAt: new Date('2026-01-05T12:00:00.000Z'),
      localDate: '2026-01-05',
    },
  ]);
  const before = await rowCounts();

  const response = await get('/learn');
  expect(response.status).toBe(200);
  const learn = await response.json();
  expect(learn).toMatchObject({
    activeSessionId: session.id,
    xp: {
      total: 22,
      today: 10,
      goal: 60,
      week: expect.arrayContaining([
        { date: '2026-01-05', xp: 12, goal: 60 },
        { date: '2026-01-07', xp: 10, goal: 60 },
      ]),
    },
  });
  expect(learn.tasks).toHaveLength(1);
  expect(learn.tasks[0]).toMatchObject({
    id: remaining.id,
    activityKind: 'learn',
    label: 'Lesson',
    conceptId: 'supervised-learning',
    title: 'Supervised learning setup',
    xp: expect.any(Number),
  });
  expect(learn.doneToday).toEqual([
    {
      activityId: expect.any(String),
      label: 'Practice',
      title: 'Vectors and vector operations',
      xp: 0,
      completedAt: '2026-01-07T11:30:00.000Z',
    },
  ]);
  expect(await rowCounts()).toEqual(before);
});

test('done-today XP rows include lesson quiz XP and sum to the earned total', async () => {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 60,
      status: 'completed',
      startedAt: new Date('2026-01-07T10:00:00.000Z'),
      endedAt: new Date('2026-01-07T11:00:00.000Z'),
    })
    .returning();
  if (!session) throw new Error('Could not create passed-quiz session');
  const [lessonActivity, reviewActivity] = await db
    .insert(sessionActivities)
    .values([
      {
        sessionId: session.id,
        idx: 0,
        kind: 'learn',
        conceptId: 'supervised-learning',
        exerciseIds: [],
        plannedMinutes: 40,
        status: 'completed',
        completedAt: new Date('2026-01-07T10:50:00.000Z'),
      },
      {
        sessionId: session.id,
        idx: 1,
        kind: 'review',
        conceptId: 'vectors',
        exerciseIds: [],
        plannedMinutes: 4,
        status: 'completed',
        completedAt: new Date('2026-01-07T11:00:00.000Z'),
      },
    ])
    .returning();
  if (!lessonActivity || !reviewActivity) {
    throw new Error('Could not create passed-quiz activities');
  }
  const [run] = await db
    .insert(lessonRuns)
    .values({
      userId,
      conceptId: 'supervised-learning',
      status: 'completed',
      startedAt: new Date('2026-01-07T10:00:00.000Z'),
      completedAt: new Date('2026-01-07T10:50:00.000Z'),
      quizPassedAt: new Date('2026-01-07T10:50:00.000Z'),
    })
    .returning();
  if (!run) throw new Error('Could not create passed lesson run');
  await db.insert(xpEvents).values([
    {
      userId,
      kind: 'knowledge_point',
      sourceKey: `kp:${run.id}:sl-inputs-targets`,
      conceptId: 'supervised-learning',
      amount: 40,
      earnedAt: new Date('2026-01-07T10:40:00.000Z'),
      localDate: '2026-01-07',
    },
    {
      userId,
      kind: 'quiz',
      sourceKey: `quiz:${run.id}`,
      conceptId: 'supervised-learning',
      amount: 8,
      earnedAt: new Date('2026-01-07T10:50:00.000Z'),
      localDate: '2026-01-07',
    },
    {
      userId,
      kind: 'activity',
      sourceKey: `activity:${reviewActivity.id}`,
      conceptId: 'vectors',
      amount: 4,
      earnedAt: new Date('2026-01-07T11:00:00.000Z'),
      localDate: '2026-01-07',
    },
  ]);

  const response = await get('/learn');
  expect(response.status).toBe(200);
  const learn = await response.json();
  expect(learn.xp.today).toBe(52);
  expect(learn.doneToday).toMatchObject([
    { activityId: lessonActivity.id, xp: 48 },
    { activityId: reviewActivity.id, xp: 4 },
  ]);
  expect(learn.doneToday.reduce((total: number, item: { xp: number }) => total + item.xp, 0)).toBe(
    learn.xp.today,
  );
});

test('learn XP goal follows the learner daily study time', async () => {
  await db
    .update(users)
    .set({ prefs: { scheduleMinutes: 30, saturdayMinutes: 45, sundayMinutes: 75 } })
    .where(eq(users.id, userId));
  const response = await get('/learn');
  expect(response.status).toBe(200);
  const learn = await response.json();
  expect(learn.xp.goal).toBe(30);
  expect(learn.xp.week.map((day: { goal: number }) => day.goal)).toEqual([
    30, 30, 30, 30, 30, 45, 75,
  ]);
});

test('session XP counts events during the session and all events from the local day', async () => {
  const [session] = await db
    .insert(studySessions)
    .values({
      userId,
      kind: 'weekday',
      plannedMinutes: 60,
      status: 'completed',
      startedAt: new Date('2026-01-07T10:00:00.000Z'),
      endedAt: new Date('2026-01-07T11:00:00.000Z'),
    })
    .returning();
  if (!session) throw new Error('Could not create XP session');
  await db.insert(xpEvents).values([
    {
      userId,
      kind: 'activity',
      sourceKey: 'xp-session-before',
      amount: 20,
      earnedAt: new Date('2026-01-07T09:59:00.000Z'),
      localDate: '2026-01-07',
    },
    {
      userId,
      kind: 'activity',
      sourceKey: 'xp-session-inside',
      amount: 15,
      earnedAt: new Date('2026-01-07T10:30:00.000Z'),
      localDate: '2026-01-07',
    },
    {
      userId,
      kind: 'activity',
      sourceKey: 'xp-session-after',
      amount: 50,
      earnedAt: new Date('2026-01-07T11:01:00.000Z'),
      localDate: '2026-01-07',
    },
    {
      userId,
      kind: 'activity',
      sourceKey: 'xp-today-only',
      amount: 10,
      earnedAt: new Date('2026-01-07T12:00:00.000Z'),
      localDate: '2026-01-07',
    },
  ]);
  const response = await get(`/sessions/${session.id}`);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.xp).toEqual({ session: 15, today: 95, goal: 60 });
});

test('request timezone updates the learner, rebuckets XP, and drives the local week', async () => {
  const earnedAt = new Date('2026-11-09T00:17:00.000Z');
  await db.insert(xpEvents).values({
    userId,
    kind: 'activity',
    sourceKey: 'timezone-rebucket',
    conceptId: 'vectors',
    amount: 10,
    earnedAt,
    localDate: '2026-11-09',
  });
  const headers = {
    'X-Now': earnedAt.toISOString(),
    'X-Time-Zone': 'America/Los_Angeles',
  };

  const learnResponse = await app.request('/api/learn', { headers });
  expect(learnResponse.status).toBe(200);
  const learn = await learnResponse.json();
  expect(learn.xp.today).toBe(10);
  expect(learn.xp.week).toContainEqual({ date: '2026-11-08', xp: 10, goal: 60 });

  const [user] = await db.select().from(users).where(eq(users.id, userId));
  const [event] = await db.select().from(xpEvents).where(eq(xpEvents.userId, userId));
  expect(user?.timezone).toBe('America/Los_Angeles');
  expect(event?.localDate).toBe('2026-11-08');
  const todayResponse = await app.request('/api/today', { headers });
  expect((await todayResponse.json()).sessionKind).toBe('sunday');
});

test('invalid timezone is ignored and a missing header uses the stored timezone', async () => {
  const invalid = await app.request('/api/learn', {
    headers: { 'X-Now': '2026-11-09T00:17:00.000Z', 'X-Time-Zone': 'Not/AZone' },
  });
  expect(invalid.status).toBe(200);
  expect((await db.select().from(users).where(eq(users.id, userId)))[0]?.timezone).toBe('UTC');

  await db.update(users).set({ timezone: 'America/Los_Angeles' }).where(eq(users.id, userId));
  const missing = await app.request('/api/today', {
    headers: { 'X-Now': '2026-11-09T00:17:00.000Z' },
  });
  expect((await missing.json()).sessionKind).toBe('sunday');
});
