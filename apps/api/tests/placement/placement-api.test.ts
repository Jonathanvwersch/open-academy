import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config.js';
import { loadContent } from '../../src/content/load.js';
import type { ContentIndex, IndexedExercise } from '../../src/content/types.js';
import { createDb } from '../../src/db/client.js';
import {
  courseEnrollments,
  diagnosticRuns,
  lessonRuns,
  mastery,
  masteryEvents,
  reviewCards,
  users,
} from '../../src/db/schema.js';
import { initialMastery } from '../../src/learning/types.js';

const db = createDb(env.TEST_DATABASE_URL);
const userId = '00000000-0000-4000-8000-000000000123';
const otherUserId = '00000000-0000-4000-8000-000000000124';
const now = '2026-01-07T12:00:00.000Z';
let app: ReturnType<typeof createApp>;
let content: ContentIndex;

beforeAll(async () => {
  content = await loadContent('tests/fixtures/content');
  app = createApp({ db, content, tutorProvider: null });
});

beforeEach(async () => {
  await db.delete(users);
  await db.insert(users).values({
    id: userId,
    displayName: 'Placement API learner',
    timezone: 'UTC',
    startDate: '2026-01-01',
    prefs: { scheduleMinutes: 60 },
  });
});

afterAll(async () => {
  await db.delete(users);
  await db.$client.end();
});

function headers() {
  return { 'Content-Type': 'application/json', 'X-Now': now };
}

async function get(path: string) {
  return app.request(`/api${path}`, { headers: headers() });
}

async function post(path: string, body: unknown) {
  return app.request(`/api${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
}

function put(path: string, body: unknown) {
  return app.request(`/api${path}`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify(body),
  });
}

async function chooseFixtureCourse() {
  const response = await put('/course/active', { courseId: 'fixture-course' });
  expect(response.status).toBe(200);
}

function correctAnswer(exercise: IndexedExercise): unknown {
  if (exercise.type === 'mc') {
    return exercise.options.find((option) => option.correct)?.id ?? '';
  }
  if (exercise.type === 'numeric' && 'answer' in exercise) return exercise.answer;
  if (exercise.type === 'expression') return exercise.answer;
  throw new Error(`Unexpected placement exercise type ${exercise.type}`);
}

test('a new learner chooses a course before course start is needed', async () => {
  const learnBefore = (await (await get('/learn')).json()) as {
    today: { needsCourseChoice: boolean };
  };
  expect(learnBefore.today.needsCourseChoice).toBe(true);

  await chooseFixtureCourse();
  const [course, learn] = await Promise.all([
    get('/course').then((response) => response.json()),
    get('/learn').then((response) => response.json()),
  ]);
  expect(course.courseStart).toEqual({ needed: true, placementRunId: null });
  expect(learn.today.needsCourseChoice).toBe(false);
  expect(learn.today.courseStart.needed).toBe(true);
  expect(
    course.courses.find((entry: { id: string }) => entry.id === 'fixture-course').started,
  ).toBe(false);
});

test('placement starts the requested course and falls back for an unknown course id', async () => {
  await chooseFixtureCourse();

  const requested = await post('/placement', { courseId: 'fixture-switching-course' });
  expect(requested.status).toBe(201);
  const requestedId = (await requested.json()).id as string;
  const [requestedRun] = await db
    .select({ state: diagnosticRuns.state })
    .from(diagnosticRuns)
    .where(eq(diagnosticRuns.id, requestedId));
  expect(requestedRun?.state).toMatchObject({ courseId: 'fixture-switching-course' });
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  expect(user?.activeCourseId).toBe('fixture-course');

  const fallback = await post('/placement', { courseId: 'unknown-course' });
  expect(fallback.status).toBe(201);
  const fallbackId = (await fallback.json()).id as string;
  const [fallbackRun] = await db
    .select({ state: diagnosticRuns.state })
    .from(diagnosticRuns)
    .where(eq(diagnosticRuns.id, fallbackId));
  expect(fallbackRun?.state).toMatchObject({ courseId: 'fixture-course' });
});

test('beginning enrolls in the active course without changing mastery', async () => {
  await chooseFixtureCourse();
  const before = await db.select().from(mastery).where(eq(mastery.userId, userId));
  const response = await post('/course/start', { method: 'beginning' });
  expect(response.status).toBe(200);
  const after = await db.select().from(mastery).where(eq(mastery.userId, userId));
  expect(after).toEqual(before);
  expect(
    await db.select().from(courseEnrollments).where(eq(courseEnrollments.userId, userId)),
  ).toMatchObject([{ courseId: 'fixture-course', status: 'active', startMethod: 'beginning' }]);
  const course = await (await get('/course')).json();
  expect(course.courseStart.needed).toBe(false);
  expect(
    course.courses.find((entry: { id: string }) => entry.id === 'fixture-course').started,
  ).toBe(true);
});

test('existing course evidence means no start card is needed without an enrollment', async () => {
  await db.insert(lessonRuns).values({
    userId,
    conceptId: 'vectors',
    status: 'in_progress',
    startedAt: new Date(now),
  });
  const [course, learn] = await Promise.all([
    get('/course').then((response) => response.json()),
    get('/learn').then((response) => response.json()),
  ]);
  expect(course.courseStart.needed).toBe(false);
  expect(learn.today.needsCourseChoice).toBe(false);
  expect(
    course.courses.find((entry: { id: string }) => entry.id === 'fixture-course').started,
  ).toBe(true);
  expect(
    await db.select().from(courseEnrollments).where(eq(courseEnrollments.userId, userId)),
  ).toHaveLength(0);
});

test('an abandoned placement resumes on the same question and rejects stale or empty answers', async () => {
  await chooseFixtureCourse();
  const start = await post('/placement', {});
  expect(start.status).toBe(201);
  const { id } = (await start.json()) as { id: string };
  const firstQuestion = await (await get(`/placement/${id}/next`)).json();
  expect(firstQuestion.complete).toBe(false);
  const [resume, sameQuestion] = await Promise.all([
    post('/placement', {}),
    get(`/placement/${id}/next`).then((response) => response.json()),
  ]);
  expect(resume.status).toBe(200);
  expect((await resume.json()).id).toBe(id);
  expect(sameQuestion.exercise.id).toBe(firstQuestion.exercise.id);
  const course = await (await get('/course')).json();
  expect(course.courseStart).toEqual({ needed: true, placementRunId: id });
  expect(
    await post(`/placement/${id}/answer`, { exerciseId: 'stale', answer: 'answer' }).then(
      (response) => response.status,
    ),
  ).toBe(409);
  expect(
    await post(`/placement/${id}/answer`, {
      exerciseId: firstQuestion.exercise.id,
      answer: '',
    }).then((response) => response.status),
  ).toBe(422);
});

test('placement answers are private to their learner and unknown runs return 404', async () => {
  await chooseFixtureCourse();
  expect(
    await get('/placement/00000000-0000-4000-8000-000000000999/next').then(
      (response) => response.status,
    ),
  ).toBe(404);
  await db.insert(users).values({
    id: otherUserId,
    displayName: 'Other learner',
    timezone: 'UTC',
    startDate: '2026-01-01',
    prefs: {},
  });
  const [run] = await db
    .insert(diagnosticRuns)
    .values({
      userId: otherUserId,
      kind: 'placement',
      status: 'active',
      state: { courseId: 'fixture-course', answers: [], known: [], unknown: [] },
    })
    .returning();
  expect(await get(`/placement/${run.id}/next`).then((response) => response.status)).toBe(404);
});

test('mixed placement credits placed-out topics, creates reviews, and keeps unknown topics learnable', async () => {
  await chooseFixtureCourse();
  const vectorsMath = initialMastery('vectors', 'math');
  vectorsMath.state = 'independent';
  await db.insert(mastery).values({
    userId,
    conceptId: vectorsMath.conceptId,
    dimension: vectorsMath.dimension,
    state: vectorsMath.state,
    provisional: false,
    inferred: false,
    evidence: {
      independentItemIds: [],
      independentDeterministicCount: 0,
      lastIndependentCorrect: false,
      attempts: [],
    },
  });
  const start = await post('/placement', {});
  const { id } = (await start.json()) as { id: string };
  let complete = false;
  let answerCount = 0;
  while (!complete && answerCount < 16) {
    const question = await (await get(`/placement/${id}/next`)).json();
    if (question.complete) {
      complete = true;
      break;
    }
    const exercise = content.exercisesById.get(question.exercise.id);
    if (!exercise) throw new Error('Missing placement exercise in content');
    const body =
      answerCount === 1
        ? { exerciseId: exercise.id, dontKnow: true }
        : { exerciseId: exercise.id, answer: correctAnswer(exercise) };
    const response = await post(`/placement/${id}/answer`, body);
    expect(response.status).toBe(200);
    complete = (await response.json()).complete;
    answerCount += 1;
  }
  expect(complete).toBe(true);
  expect(answerCount).toBeGreaterThanOrEqual(2);

  const [run] = await db.select().from(diagnosticRuns).where(eq(diagnosticRuns.id, id));
  const state = run?.state as { known: string[]; unknown: string[] };
  expect(state.known).toContain('vectors');
  const placementEvents = (
    await db.select().from(masteryEvents).where(eq(masteryEvents.userId, userId))
  ).filter((event) => event.rule === 'placement_placed_out');
  expect(placementEvents.every((event) => event.fromState !== event.toState)).toBe(true);
  expect(
    placementEvents.some((event) => event.conceptId === 'vectors' && event.dimension === 'math'),
  ).toBe(false);
  const results = await (await get(`/placement/${id}/results`)).json();
  expect(results.topicsTotal).toBe(9);
  expect(results.topicsDone).toBeGreaterThan(0);
  expect(results.placedOut.length).toBeGreaterThan(0);
  const fixtureCourse = content.coursesById.get('fixture-course');
  if (!fixtureCourse) throw new Error('Missing fixture course');
  const known = new Set(state.known);
  const unitConceptIds = [...new Set(fixtureCourse.units.flatMap((unit) => unit.concepts))];
  expect(results.placedOut).toEqual(
    unitConceptIds.flatMap((conceptId) => {
      if (!known.has(conceptId)) return [];
      const concept = content.conceptsById.get(conceptId);
      return concept ? [concept.title] : [];
    }),
  );
  expect(results.foundationsPlacedOut).toEqual([]);
  const course = await (await get('/course')).json();
  const courseProgress = course.courses.find(
    (entry: { id: string }) => entry.id === 'fixture-course',
  );
  expect(results.topicsTotal).toBe(courseProgress.topicsTotal);
  expect(results.topicsDone).toBe(courseProgress.topicsDone);
  const topics = course.units.flatMap(
    (unit: {
      topics: Array<{
        title: string;
        conceptId: string;
        status: string;
        placedOut: boolean;
        hasLesson: boolean;
      }>;
    }) => unit.topics,
  );
  expect(results.topicsDone).toBe(
    topics.filter((topic: { status: string }) => topic.status === 'complete').length,
  );
  const firstUnknownTopic = [...course.foundations, ...topics].find(
    (topic: { hasLesson: boolean; status: string }) =>
      topic.hasLesson && topic.status !== 'complete',
  );
  expect(topics.filter((topic: { placedOut: boolean }) => topic.placedOut).length).toBeGreaterThan(
    0,
  );
  expect(
    course.courses.find((entry: { id: string }) => entry.id === 'fixture-course').started,
  ).toBe(true);
  expect(
    topics
      .filter((topic: { placedOut: boolean }) => topic.placedOut)
      .every((topic: { status: string }) => topic.status === 'complete'),
  ).toBe(true);
  const reviews = await db.select().from(reviewCards).where(eq(reviewCards.userId, userId));
  expect(reviews.length).toBeGreaterThan(0);
  for (const conceptId of state.known) {
    const concept = content.conceptsById.get(conceptId);
    if (!concept) continue;
    expect(reviews.filter((review) => review.conceptId === conceptId)).toHaveLength(
      concept.dimensions.length,
    );
  }
  const today = await (await get('/today')).json();
  const learnIds = today.plan.activities
    .filter((activity: { kind: string }) => activity.kind === 'learn')
    .map((activity: { conceptId?: string }) => activity.conceptId);
  expect(learnIds.some((conceptId: string) => state.known.includes(conceptId))).toBe(false);
  expect(learnIds.length).toBeGreaterThan(0);
  expect(learnIds[0]).toBe(firstUnknownTopic?.conceptId);
  expect(results.firstTopic).toBeTruthy();
  expect(results.firstTopic).toBe(content.conceptsById.get(learnIds[0])?.title);
  const completedRuns = await db.select().from(lessonRuns).where(eq(lessonRuns.userId, userId));
  expect(completedRuns).toHaveLength(0);

  const placedOutConceptId = topics.find(
    (topic: { conceptId: string; placedOut: boolean }) =>
      topic.placedOut &&
      topic.conceptId !== 'vectors' &&
      content.conceptsById.get(topic.conceptId)?.dimensions.includes('math'),
  )?.conceptId;
  if (!placedOutConceptId) throw new Error('Missing a placed-out topic');

  const sessionResponse = await post('/sessions', {});
  expect(sessionResponse.status).toBe(201);
  const session = await sessionResponse.json();
  expect(
    session.activities.some((activity: { kind: string }) =>
      ['quick_check', 'transfer', 'teachback', 'reflect'].includes(activity.kind),
    ),
  ).toBe(false);
  const courseAfterSession = await get('/course').then((response) => response.json());
  const topicAfterSession = courseAfterSession.units
    .flatMap((unit: { topics: Array<{ conceptId: string; status: string }> }) => unit.topics)
    .find((topic: { conceptId: string }) => topic.conceptId === placedOutConceptId);
  expect(topicAfterSession).toMatchObject({ status: 'complete', placedOut: true });
});

test('placement results separate known foundations from course topics', async () => {
  const originalApp = app;
  const originalContent = content;
  const foundationContent = await loadContent('tests/fixtures/content');
  const vectors = foundationContent.conceptsById.get('vectors');
  if (!vectors) throw new Error('Missing vectors fixture');
  const foundation = {
    ...vectors,
    id: 'fixture-foundation',
    title: 'Fixture foundation',
    description: 'A prerequisite outside the active course.',
    prereqs: [],
    related: [],
  };
  vectors.prereqs = [{ id: foundation.id, strength: 'hard' }];
  foundationContent.concepts.push(foundation);
  foundationContent.conceptsById.set(foundation.id, foundation);
  foundationContent.edges.push({
    conceptId: vectors.id,
    prerequisiteId: foundation.id,
    strength: 'hard',
  });
  content = foundationContent;
  app = createApp({ db, content, tutorProvider: null });

  try {
    await chooseFixtureCourse();
    const start = await post('/placement', {});
    const { id } = (await start.json()) as { id: string };
    const state = {
      courseId: 'fixture-course',
      answers: [],
      known: ['fixture-foundation', 'vectors'],
      unknown: [],
    };
    await db
      .update(diagnosticRuns)
      .set({ state, status: 'completed', completedAt: new Date(now), summary: state })
      .where(eq(diagnosticRuns.id, id));

    const results = await get(`/placement/${id}/results`).then((response) => response.json());
    expect(results.placedOut).toEqual(['Vectors']);
    expect(results.foundationsPlacedOut).toEqual(['Fixture foundation']);
    const course = await get('/course').then((response) => response.json());
    const courseProgress = course.courses.find(
      (entry: { id: string }) => entry.id === 'fixture-course',
    );
    expect(results.topicsTotal).toBe(courseProgress.topicsTotal);
    expect(results.topicsDone).toBe(courseProgress.topicsDone);
  } finally {
    app = originalApp;
    content = originalContent;
  }
});

test('a correctly answered single-dimension topic keeps its placed-out badge without an event', async () => {
  const originalApp = app;
  const originalContent = content;
  const singleContent = await loadContent('tests/fixtures/content');
  const baseCourse = singleContent.coursesById.get('fixture-course');
  const baseConcept = singleContent.conceptsById.get('vectors');
  const baseExercise = singleContent.exercises.find(
    (exercise): exercise is Extract<IndexedExercise, { type: 'mc' }> => exercise.type === 'mc',
  );
  if (!baseCourse || !baseConcept || !baseExercise) {
    throw new Error('Missing single-dimension placement fixtures');
  }
  const conceptId = 'single-dimension-topic';
  const concept = {
    ...baseConcept,
    id: conceptId,
    title: 'Single-dimension topic',
    dimensions: ['math'] as ['math'],
    prereqs: [],
  };
  const exercise = {
    ...baseExercise,
    id: 'single-dimension-probe',
    concept: conceptId,
    dimension: 'math' as const,
    role: 'core' as const,
    difficulty: 2,
  };
  const course = {
    ...baseCourse,
    units: [{ title: 'Single-dimension unit', concepts: [conceptId] }],
  };
  const curriculum = singleContent.curriculum;
  if (!curriculum) throw new Error('Missing fixture curriculum');
  singleContent.curriculum = {
    ...curriculum,
    courses: [course.id],
    default_course: course.id,
  };
  singleContent.courses = [course];
  singleContent.coursesById = new Map([[course.id, course]]);
  singleContent.concepts.push(concept);
  singleContent.conceptsById.set(conceptId, concept);
  singleContent.exercises.push(exercise);
  singleContent.exercisesById.set(exercise.id, exercise);
  singleContent.exercisesByConcept.set(conceptId, [exercise]);
  content = singleContent;
  app = createApp({ db, content, tutorProvider: null });

  try {
    await chooseFixtureCourse();
    const start = await post('/placement', {});
    const { id } = (await start.json()) as { id: string };
    const question = await get(`/placement/${id}/next`).then((response) => response.json());
    expect(question.exercise.id).toBe(exercise.id);
    const answer = await post(`/placement/${id}/answer`, {
      exerciseId: exercise.id,
      answer: correctAnswer(exercise),
    });
    expect(answer.status).toBe(200);
    expect((await answer.json()).complete).toBe(true);
    const events = await db.select().from(masteryEvents).where(eq(masteryEvents.userId, userId));
    expect(
      events.filter(
        (event) => event.conceptId === conceptId && event.rule === 'placement_placed_out',
      ),
    ).toHaveLength(0);
    const coursePayload = await get('/course').then((response) => response.json());
    const topic = coursePayload.units
      .flatMap(
        (unit: { topics: Array<{ conceptId: string; status: string; placedOut: boolean }> }) =>
          unit.topics,
      )
      .find((entry: { conceptId: string }) => entry.conceptId === conceptId);
    expect(topic).toMatchObject({ status: 'complete', placedOut: true });
  } finally {
    app = originalApp;
    content = originalContent;
  }
});

test('placement results keep their first topic after switching courses', async () => {
  const originalApp = app;
  const originalContent = content;
  const realContent = await loadContent('content');
  content = realContent;
  app = createApp({ db, content, tutorProvider: null });

  try {
    const placementCourseId = 'ml-foundations';
    const activeCourse = await put('/course/active', { courseId: placementCourseId });
    expect(activeCourse.status).toBe(200);
    const start = await post('/placement', {});
    const { id } = (await start.json()) as { id: string };
    let complete = false;
    for (let answerCount = 0; answerCount < 16 && !complete; answerCount += 1) {
      const question = await get(`/placement/${id}/next`).then((response) => response.json());
      if (question.complete) {
        complete = true;
        break;
      }
      const exercise = realContent.exercisesById.get(question.exercise.id);
      if (!exercise) throw new Error('Missing placement exercise in content');
      const response = await post(`/placement/${id}/answer`, {
        exerciseId: exercise.id,
        dontKnow: true,
      });
      expect(response.status).toBe(200);
      complete = (await response.json()).complete;
    }
    expect(complete).toBe(true);

    const todayBeforeSwitch = await get('/today').then((response) => response.json());
    const firstLearnId = todayBeforeSwitch.plan.activities.find(
      (activity: { kind: string; conceptId?: string }) => activity.kind === 'learn',
    )?.conceptId;
    if (!firstLearnId) throw new Error('Placement course has no next learning topic');

    let switchedCourse = false;
    for (const course of realContent.courses.filter((entry) => entry.id !== placementCourseId)) {
      const switched = await put('/course/active', { courseId: course.id });
      expect(switched.status).toBe(200);
      const today = await get('/today').then((response) => response.json());
      const firstLearn = today.plan.activities.find(
        (activity: { kind: string; conceptId?: string }) => activity.kind === 'learn',
      )?.conceptId;
      if (firstLearn && firstLearn !== firstLearnId) {
        switchedCourse = true;
        break;
      }
    }
    expect(switchedCourse).toBe(true);
    const results = await get(`/placement/${id}/results`).then((response) => response.json());
    expect(results.firstTopic).toBe(realContent.conceptsById.get(firstLearnId)?.title);
  } finally {
    app = originalApp;
    content = originalContent;
  }
});
