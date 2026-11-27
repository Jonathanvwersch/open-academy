import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { loadContentFromDirectory } from '../course/load.js';
import { activityRow, sessionRow } from '../store/learner-store.contract.js';
import { memoryStore } from '../store/memory-store.js';
import { createEngine } from './create-engine.js';

const content = loadContentFromDirectory(
  fileURLToPath(new URL('../../../../content', import.meta.url)),
);

test('hints and quiz reviews accept memory-issued activity and attempt IDs', async () => {
  const index = await content;
  const exercise = index.exercises.find(
    ({ hints, role }) => hints.length > 0 && role !== 'diagnostic',
  );
  const lessonEntry = [...index.lessonsByConcept.entries()].find(
    ([, lesson]) => lesson.knowledge_points?.length,
  );
  if (!exercise || !lessonEntry) throw new Error('Missing lesson or hinted exercise fixture');
  const [conceptId, lesson] = lessonEntry;
  const pointId = lesson.knowledge_points?.[0]?.id;
  if (!pointId) throw new Error('Missing lesson knowledge point fixture');

  const learnerId = 'learner';
  const now = new Date('2026-01-17T12:00:00Z');
  const store = memoryStore();
  const session = await store.insertSession(learnerId, {
    ...sessionRow(now),
    status: 'completed',
    endedAt: now,
  });
  const [activity] = await store.insertActivities(learnerId, session.id, [
    activityRow(0, { exerciseIds: [exercise.id] }),
  ]);
  if (!activity) throw new Error('Activity did not insert');

  const run = await store.insertLessonRunIfAbsent(learnerId, {
    conceptId,
    status: 'completed',
    startedAt: now,
    updatedAt: now,
    completedAt: now,
    quizPassedAt: now,
    attempt: 1,
    haltedAt: null,
    retryAfter: null,
    haltedPointIndex: null,
    haltCount: 0,
  });
  if (!run) throw new Error('Lesson run did not insert');
  const attempt = await store.insertLessonQuiz(
    learnerId,
    run.id,
    { attemptNo: 1, startedAt: now, submittedAt: now, score: 1, passed: true },
    [
      {
        position: 0,
        knowledgePointId: pointId,
        exerciseId: exercise.id,
        seed: 0,
        answer: '',
        evidence: null,
        correct: 1,
        durationMs: 1_000,
        attemptId: null,
        answeredAt: now,
      },
    ],
  );

  const learner = createEngine({
    content: async () => index,
    store,
    fsrsFuzz: false,
  }).learner({
    id: learnerId,
    timeZone: 'UTC',
    now: () => now,
    random: () => 0.5,
  });
  expect(activity.id).toMatch(/^activity-/);
  expect(attempt.id).toMatch(/^lesson-quiz-/);
  expect(
    await learner.hint({ body: { exerciseId: exercise.id, activityId: activity.id } }),
  ).toMatchObject({
    status: 200,
    body: { level: 1, text: exercise.hints[0] },
  });
  expect(await learner.lessonQuizReview({ conceptId, attemptId: attempt.id })).toMatchObject({
    status: 200,
    body: {
      attemptId: attempt.id,
      items: [{ position: 0, pointId, exercise: { id: exercise.id } }],
    },
  });
});

test('paper summaries save progress and reveal the rubric in the memory store', async () => {
  const index = await content;
  const paper = index.papers[0];
  if (!paper) throw new Error('Missing paper fixture');
  const learnerId = 'learner';
  const now = new Date('2026-01-17T12:00:00Z');
  const store = memoryStore();
  const learner = createEngine({
    content: async () => index,
    store,
  }).learner({
    id: learnerId,
    timeZone: 'UTC',
    now: () => now,
    random: () => 0.5,
  });

  expect(await learner.paper({ id: paper.id })).toMatchObject({
    status: 200,
    body: { paper: { summary: { prompt: paper.summary.prompt } } },
  });
  const saved = await learner.submitPaperSummary({
    id: paper.id,
    body: { summary: 'A concise summary.' },
  });
  expect(saved).toMatchObject({
    status: 200,
    body: { judgement: null, reason: 'Tutor grading is disabled.', completedAt: now.toISOString() },
  });
  expect(await learner.paper({ id: paper.id })).toMatchObject({
    status: 200,
    body: { paper: { summary: { rubric: paper.summary.rubric } } },
  });
  expect(await store.getPaperProgress(learnerId, paper.id)).toMatchObject({
    summary: 'A concise summary.',
    summaryJudgement: null,
    completedAt: now,
  });
});

test('paper summary accepts memory activity IDs and advances from current session activities', async () => {
  const index = await content;
  const paper = index.papers[0];
  if (!paper) throw new Error('Missing paper fixture');
  const learnerId = 'learner';
  const now = new Date('2026-01-17T12:00:00Z');
  const store = memoryStore();
  const session = await store.insertSession(learnerId, sessionRow(now));
  const [activity, nextActivity] = await store.insertActivities(learnerId, session.id, [
    activityRow(0, { kind: 'paper', status: 'in_progress' }),
    activityRow(1, { kind: 'practice', status: 'planned' }),
  ]);
  if (!activity || !nextActivity) throw new Error('Session activities did not insert');
  expect(activity.id).toMatch(/^activity-/);

  let signalJudgeStarted!: () => void;
  let resolveJudgement!: (result: { judgement: unknown } | { reason: string }) => void;
  const judgeStarted = new Promise<void>((resolve) => {
    signalJudgeStarted = resolve;
  });
  const judgement = new Promise<{ judgement: unknown } | { reason: string }>((resolve) => {
    resolveJudgement = resolve;
  });
  const learner = createEngine({ content: async () => index, store }).learner({
    id: learnerId,
    timeZone: 'UTC',
    now: () => now,
    random: () => 0.5,
    judgeSummary: async () => {
      signalJudgeStarted();
      return judgement;
    },
  });

  const submitted = learner.submitPaperSummary({
    id: paper.id,
    body: { summary: 'A concise summary.', activityId: activity.id },
  });
  await judgeStarted;
  await store.patchActivities(
    learnerId,
    { ids: [nextActivity.id] },
    { status: 'completed', completedAt: now },
  );
  resolveJudgement({ judgement: { score: 1 } });
  expect(await submitted).toMatchObject({ status: 200, body: { judgement: { score: 1 } } });
  expect(await store.listActivities(learnerId, { ids: [nextActivity.id] })).toMatchObject([
    { status: 'completed' },
  ]);
});

test('a completed lesson is unpinned when its content gains a knowledge point', async () => {
  const originalIndex = await content;
  const fixture = [...originalIndex.lessonsByConcept.entries()].flatMap(([conceptId, lesson]) => {
    const progression = (lesson.knowledge_points ?? []).map((point) => ({
      point,
      exercises: point.problems
        .flatMap((id) => {
          const exercise = originalIndex.exercisesById.get(id);
          return exercise && exercise.role !== 'recall' ? [exercise] : [];
        })
        .slice(0, 2),
    }));
    return progression.length === 3 && progression.every(({ exercises }) => exercises.length === 2)
      ? [{ conceptId, lesson, progression }]
      : [];
  })[0];
  if (!fixture) throw new Error('Missing three-point lesson fixture');
  const { conceptId, lesson, progression } = fixture;
  const points = progression.map(({ point }) => point);
  const firstPoint = points[0];
  const firstProblem = progression[0]?.exercises[0];
  if (!firstPoint || !firstProblem) throw new Error('Missing lesson progression problems');
  const contentIndex = {
    ...originalIndex,
    lessonsByConcept: new Map(originalIndex.lessonsByConcept),
  };
  const learnerId = 'learner';
  const now = new Date('2026-01-17T12:00:00Z');
  const store = memoryStore();
  const session = await store.insertSession(learnerId, {
    ...sessionRow(now),
    status: 'completed',
    endedAt: now,
  });
  const [completedActivity, nextActivity] = await store.insertActivities(learnerId, session.id, [
    activityRow(0, {
      conceptId,
      exerciseIds: [lesson.final ?? firstProblem.id],
      status: 'completed',
      progress: { lessonRunnerContinued: true, finalQuestionContinued: true },
    }),
    activityRow(1, {
      conceptId,
      kind: 'practice',
      exerciseIds: [firstProblem.id],
      status: 'in_progress',
    }),
  ]);
  if (!completedActivity || !nextActivity) throw new Error('Session activities did not insert');
  const run = await store.insertLessonRunIfAbsent(learnerId, {
    conceptId,
    status: 'completed',
    startedAt: now,
    updatedAt: now,
    completedAt: now,
    quizPassedAt: now,
    attempt: 1,
    haltedAt: null,
    retryAfter: null,
    haltedPointIndex: null,
    haltCount: 0,
  });
  if (!run) throw new Error('Lesson run did not insert');
  await Promise.all(
    progression.flatMap(({ point, exercises }) =>
      exercises.map((exercise, position) =>
        store.insertLessonProblem(learnerId, run.id, {
          knowledgePointId: point.id,
          round: 1,
          position,
          exerciseId: exercise.id,
          seed: null,
          practiceOnly: false,
          assisted: false,
          servedAt: now,
          answeredAt: now,
          correct: 1,
          attemptId: null,
        }),
      ),
    ),
  );

  const learner = createEngine({
    content: async () => contentIndex,
    store,
    fsrsFuzz: false,
  }).learner({
    id: learnerId,
    timeZone: 'UTC',
    now: () => now,
    random: () => 0.5,
  });
  const readSession = async () => {
    const result = await learner.session({ sessionId: session.id });
    expect(result.status).toBe(200);
    return result.body as {
      current: { activityId?: string; openableIds: string[] };
      activities: Array<{ id: string; lessonRunner?: boolean; lessonQuiz?: boolean }>;
    };
  };
  expect((await readSession()).current).toEqual({
    activityId: completedActivity.id,
    openableIds: [],
  });

  contentIndex.lessonsByConcept.set(conceptId, {
    ...lesson,
    knowledge_points: [...points, { ...firstPoint, id: `${firstPoint.id}-added` }],
  });
  const changed = await readSession();
  expect(changed.current).toEqual({
    activityId: nextActivity.id,
    openableIds: [completedActivity.id, nextActivity.id],
  });
  expect(changed.activities.find(({ id }) => id === completedActivity.id)).toMatchObject({
    lessonRunner: true,
    lessonQuiz: false,
  });
  expect(await store.getLessonRun(learnerId, { runId: run.id })).toMatchObject({
    status: 'completed',
  });
});
