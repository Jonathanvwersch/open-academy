import { fileURLToPath } from 'node:url';
import { Rating } from 'ts-fsrs';
import { expect, test, vi } from 'vitest';
import { loadContentFromDirectory } from '../course/load.js';
import { activityRow, sessionRow } from '../store/learner-store.contract.js';
import { memoryStore } from '../store/memory-store.js';
import type { QuizQuestion } from './mixed-quiz.js';
import { answerQuiz, finalizeQuiz, getQuiz, startQuiz, startQuizRetake } from './quiz-commands.js';
import { quizOffer } from './quiz-offer.js';

const learnerId = 'learner';
const startedAt = new Date('2026-01-17T12:00:00Z');
const deadline = new Date(startedAt.getTime() + 60_000);
const content = loadContentFromDirectory(
  fileURLToPath(new URL('../../../../content', import.meta.url)),
);

function question(concept: string, variant = 0): QuizQuestion {
  const id = `${concept}-${variant}`;
  return {
    seed: 0,
    key: id,
    exercise: {
      id,
      concept,
      type: 'numeric',
      role: 'recall',
      dimension: 'math',
      difficulty: 2,
      est_minutes: 1,
      target_seconds: 5,
      contentVersion: '1',
      prompt: id,
      hints: [],
      lesson_only: false,
      solution: '42',
      answer: 42,
      tolerance: {},
    },
  };
}

async function runtime() {
  let attempts = 0;
  const index = await content;
  const fixtures = ['derivatives', 'vectors', 'integrals'].flatMap((concept) =>
    [0, 1].map((variant) => question(concept, variant).exercise),
  );
  return {
    learnerId,
    timeZone: 'UTC',
    now: startedAt,
    content: {
      ...index,
      exercisesById: new Map([
        ...index.exercisesById,
        ...fixtures.map((exercise) => [exercise.id, exercise] as const),
      ]),
    },
    random: () => 0.5,
    newId: () => `attempt-${++attempts}`,
    enableFsrsFuzz: false,
  };
}

test('offers and starts one timed quiz using eligible XP, with its accommodation and unchanged deadline on replay', async () => {
  const context = await runtime();
  const store = memoryStore({
    settings: new Map([
      [
        learnerId,
        {
          activeCourseId: 'maths-for-ml',
          timeZone: 'UTC',
          startDate: '2026-01-17',
          studySetInitializedAt: startedAt,
          prefs: { quizTimeMultiplier: 1.5 },
        },
      ],
    ]),
  });
  const session = await store.insertSession(learnerId, sessionRow(startedAt));
  const [quiz, review, lab] = await store.insertActivities(learnerId, session.id, [
    activityRow(0, { kind: 'mixed_quiz', status: 'in_progress', plannedMinutes: 30 }),
    activityRow(1, { kind: 'review', status: 'completed' }),
    activityRow(2, { kind: 'lab', status: 'completed' }),
  ]);
  const start = { sessionId: session.id, activityId: quiz.id };
  expect(await startQuiz(store, context, start)).toMatchObject({ kind: 'conflict' });
  const offer = () => quizOffer(store, learnerId, context.content, startedAt, 'maths-for-ml');
  const activityReads = vi.spyOn(store, 'listActivities');
  expect(await offer()).toEqual({ xpBalance: 0 });
  expect(activityReads).not.toHaveBeenCalled();
  const xp = { conceptId: null, earnedAt: startedAt, localDate: '2026-01-17' };
  await store.insertXpEventOnce(learnerId, {
    ...xp,
    kind: 'knowledge_point',
    sourceKey: 'kp',
    amount: 140,
  });
  await store.insertXpEventOnce(learnerId, {
    ...xp,
    kind: 'activity',
    sourceKey: `activity:${review.id}`,
    amount: 5,
  });
  await store.insertXpEventOnce(learnerId, {
    ...xp,
    kind: 'activity',
    sourceKey: `activity:${lab.id}`,
    amount: 20,
  });
  await store.insertXpEventOnce(learnerId, {
    ...xp,
    kind: 'activity',
    sourceKey: 'activity:missing',
    amount: 20,
  });
  await store.insertXpEventOnce(learnerId, {
    ...xp,
    kind: 'review',
    sourceKey: 'future',
    amount: 20,
    earnedAt: deadline,
  });
  expect(await offer()).toEqual({ xpBalance: 145 });
  expect(activityReads).toHaveBeenCalledExactlyOnceWith(learnerId, {
    ids: [review.id, lab.id, 'missing'],
  });
  activityReads.mockRestore();
  await store.insertXpEventOnce(learnerId, {
    ...xp,
    kind: 'review',
    sourceKey: 'review',
    amount: 5,
  });
  expect(await offer()).toEqual({ xpBalance: 150 });
  for (const { concept } of context.content.lessons) {
    await store.insertLessonRunIfAbsent(learnerId, {
      conceptId: concept,
      status: 'completed',
      startedAt,
      updatedAt: startedAt,
      completedAt: startedAt,
      quizPassedAt: startedAt,
      attempt: 1,
      haltedAt: null,
      retryAfter: null,
      haltedPointIndex: null,
      haltCount: 0,
    });
  }
  expect(await offer()).toMatchObject({ selection: { accommodation: 1.5, difficulty: 2 } });
  const result = await startQuiz(store, context, start);
  if (result.kind !== 'created') throw new Error('Quiz did not start');
  expect(result.body).toMatchObject({ totalItems: 8, question: { position: 0 } });
  const next = await startQuiz(
    store,
    { ...context, now: new Date(startedAt.getTime() + 1000) },
    start,
  );
  expect(next).toMatchObject({
    kind: 'ok',
    body: { id: result.body.id, deadline: result.body.deadline },
  });
  expect(await store.listTimedQuizRuns(learnerId, { active: true })).toHaveLength(1);
});

test.each([false, true])(
  'finalizes and retakes once; slow and missing answers are due immediately (prior speed successes: %s)',
  async (success) => {
    const context = await runtime();
    const store = memoryStore();
    const run = await store.insertTimedQuiz(
      learnerId,
      {
        seed: 1,
        difficulty: 2,
        plannedMinutes: 6,
        activityId: null,
        retakeOf: null,
        startedAt,
        deadline,
        finalizedAt: null,
        score: null,
        xpAwarded: null,
      },
      ['derivatives', 'vectors', 'integrals'].map((conceptId, position) => ({
        position,
        conceptId,
        question: question(conceptId),
        reserve: question(conceptId, 1),
        answeredAt: null,
        latencyMs: null,
        submission: null,
        correct: null,
        followUp: false,
        followUpActivityId: null,
      })),
    );
    for (let i = 0; i < 4; i++)
      await store.addTopicSpeedAnswer(learnerId, 'vectors', success, startedAt);
    expect(
      await answerQuiz(store, context, run.id, {
        position: 0,
        questionId: 'derivatives-0',
        answer: '',
      }),
    ).toMatchObject({
      kind: 'invalid',
    });
    expect(await finalizeQuiz(store, context, run.id)).toMatchObject({ kind: 'conflict' });
    expect(
      await answerQuiz(store, { ...context, now: new Date(startedAt.getTime() + 1_000) }, run.id, {
        position: 0,
        questionId: 'derivatives-0',
        answer: 42,
      }),
    ).toMatchObject({ kind: 'ok' });
    expect(
      await answerQuiz(store, { ...context, now: new Date(startedAt.getTime() + 7_000) }, run.id, {
        position: 1,
        questionId: 'vectors-0',
        answer: 42,
      }),
    ).toMatchObject({ kind: 'ok' });
    const late = { ...context, now: deadline };
    expect(
      await answerQuiz(store, late, run.id, { position: 2, questionId: 'integrals-0', answer: 42 }),
    ).toMatchObject({
      kind: 'conflict',
      error: 'This quiz has ended',
    });
    const [first, second] = await Promise.all([
      finalizeQuiz(store, late, run.id),
      finalizeQuiz(store, late, run.id),
    ]);
    expect(first).toMatchObject({ kind: 'ok', body: { result: { score: 2 / 3, xpAwarded: 4 } } });
    expect(first).toEqual(second);
    expect(await store.listAttempts(learnerId, {})).toHaveLength(2);
    expect(await store.listXpEvents(learnerId, {})).toMatchObject([
      { kind: 'mixed_quiz', amount: 4 },
    ]);
    expect(await store.getReviewCard(learnerId, 'vectors', 'math')).toMatchObject({
      dueAt: deadline,
    });
    expect(await store.getReviewCard(learnerId, 'integrals', 'math')).toMatchObject({
      dueAt: deadline,
    });
    expect(
      (await store.getReviewCard(learnerId, 'derivatives', 'math'))?.dueAt.getTime(),
    ).toBeGreaterThan(deadline.getTime());
    expect(
      (await store.listReviewLogs(learnerId, {})).filter(
        ({ conceptId }) => conceptId === 'vectors',
      ),
    ).toMatchObject([{ rating: Rating.Hard }]);
    expect(await store.listTopicSpeedEvidence(learnerId, ['integrals'])).toEqual([]);
    expect(await startQuizRetake(store, late, run.id)).toMatchObject({ kind: 'conflict' });
    const session = await store.insertSession(learnerId, sessionRow(deadline));
    const [review] = await store.insertActivities(learnerId, session.id, [
      activityRow(0, { kind: 'review' }),
    ]);
    await store.linkTimedQuizFollowUps(learnerId, ['vectors', 'integrals'], review.id);
    const [started, replay] = await Promise.all([
      startQuizRetake(store, late, run.id),
      startQuizRetake(store, late, run.id),
    ]);
    expect(started).toMatchObject({
      kind: 'created',
      body: { retake: true, question: { exercise: { id: 'derivatives-1' } } },
    });
    expect(replay).toEqual({ ...started, kind: 'ok' });
    expect(await store.listTimedQuizRuns(learnerId, { retakeOf: run.id })).toHaveLength(1);
  },
);

test.each(['current item', 'stale submission', 'expiry', 'retake reserve'] as const)(
  'does not use a deleted timed quiz question (%s)',
  async (deleted) => {
    const context = await runtime();
    const store = memoryStore();
    const [item, reserve, replacement] = ['vecp-entry', 'vecp-missing-move', 'vecp-subtract'].map(
      (id): QuizQuestion => {
        const exercise = context.content.exercisesById.get(id);
        if (exercise?.type !== 'numeric') throw new Error(`Missing quiz fixture: ${id}`);
        return { key: exercise.prompt, seed: 0, exercise };
      },
    );
    const run = await store.insertTimedQuiz(
      learnerId,
      {
        seed: 1,
        difficulty: 2,
        plannedMinutes: 1,
        activityId: null,
        retakeOf: null,
        startedAt,
        deadline,
        finalizedAt: null,
        score: null,
        xpAwarded: null,
      },
      [
        {
          position: 0,
          conceptId: item.exercise.concept,
          question: item,
          reserve,
          answeredAt: null,
          latencyMs: null,
          submission: null,
          correct: null,
          followUp: false,
          followUpActivityId: null,
        },
      ],
    );
    const before = await getQuiz(
      store,
      learnerId,
      run.id,
      async () => context.content,
      () => startedAt,
    );
    expect(before).toMatchObject({
      kind: 'ok',
      body: { question: { exercise: { id: item.exercise.id } } },
    });

    const removed = deleted === 'retake reserve' ? reserve.exercise.id : item.exercise.id;
    const keep = ({ id }: { id: string }) => id !== removed;
    const revised = {
      ...context.content,
      exercisesById: new Map(
        [...context.content.exercisesById].filter(([, exercise]) => keep(exercise)),
      ),
      exercisesByConcept: new Map(
        [...context.content.exercisesByConcept].map(([id, exercises]) => [
          id,
          exercises.filter(keep),
        ]),
      ),
      exercisesByRole: new Map(
        [...context.content.exercisesByRole].map(([role, exercises]) => [
          role,
          exercises.filter(keep),
        ]),
      ),
    };
    expect(revised.exercisesById.has(replacement.exercise.id)).toBe(true);
    if (deleted === 'current item') {
      const recovered = await getQuiz(
        store,
        learnerId,
        run.id,
        async () => revised,
        () => startedAt,
      );
      expect(recovered).toMatchObject({
        kind: 'ok',
        body: {
          deadline: deadline.toISOString(),
          question: { exercise: { id: expect.not.stringMatching(new RegExp(`^${removed}$`)) } },
        },
      });
    } else if (deleted === 'stale submission') {
      expect(
        await answerQuiz(store, { ...context, content: revised }, run.id, {
          position: 0,
          questionId: removed,
          answer: 0,
        }),
      ).toMatchObject({
        kind: 'conflict',
        error: 'Question changed. Answer the current question.',
      });
      expect(await store.listTimedQuizItems(learnerId, [run.id])).toMatchObject([
        { answeredAt: null, submission: null },
      ]);
    } else if (deleted === 'expiry') {
      expect(
        await finalizeQuiz(store, { ...context, content: revised, now: deadline }, run.id),
      ).toMatchObject({ kind: 'ok', body: { result: { topics: [] } } });
      expect(await store.listReviewLogs(learnerId, {})).toEqual([]);
    } else {
      expect(await finalizeQuiz(store, { ...context, now: deadline }, run.id)).toMatchObject({
        kind: 'ok',
        body: { result: { score: 0, retake: { eligible: false } } },
      });
      const session = await store.insertSession(learnerId, sessionRow(deadline));
      const [review] = await store.insertActivities(learnerId, session.id, [
        activityRow(0, { kind: 'review', status: 'completed' }),
      ]);
      await store.linkTimedQuizFollowUps(learnerId, [item.exercise.concept], review.id);
      expect(
        await startQuizRetake(store, { ...context, content: revised, now: deadline }, run.id),
      ).toMatchObject({
        kind: 'created',
        body: {
          retake: true,
          question: { exercise: { id: expect.not.stringMatching(new RegExp(`^${removed}$`)) } },
        },
      });
    }
  },
);

test('withdraws an unreplaceable item without losing a deleted item’s saved answer', async () => {
  const context = await runtime();
  const store = memoryStore();
  const saved = question('vectors');
  const withdrawn = question('integrals');
  const run = await store.insertTimedQuiz(
    learnerId,
    {
      seed: 1,
      difficulty: 2,
      plannedMinutes: 5,
      activityId: null,
      retakeOf: null,
      startedAt,
      deadline,
      finalizedAt: null,
      score: null,
      xpAwarded: null,
    },
    [withdrawn, saved].map((item, position) => ({
      position,
      conceptId: item.exercise.concept,
      question: item,
      reserve: null,
      answeredAt: position === 1 ? startedAt : null,
      latencyMs: position === 1 ? 1000 : null,
      submission: position === 1 ? { answer: 42, correct: 1, gradedBy: 'deterministic' } : null,
      correct: position === 1 ? true : null,
      followUp: false,
      followUpActivityId: null,
    })),
  );
  const revised = {
    ...context.content,
    exercisesById: new Map(),
    exercisesByConcept: new Map(),
  };
  expect(
    await getQuiz(
      store,
      learnerId,
      run.id,
      async () => revised,
      () => startedAt,
    ),
  ).toMatchObject({
    kind: 'ok',
    body: { totalItems: 1, question: null, deadline: deadline.toISOString() },
  });
  expect(await finalizeQuiz(store, { ...context, content: revised }, run.id)).toMatchObject({
    kind: 'ok',
    body: { totalItems: 1, result: { score: 1, xpAwarded: 5, topics: [] } },
  });
  expect(await store.listAttempts(learnerId, {})).toMatchObject([
    { exerciseId: saved.exercise.id },
  ]);
  expect(await store.listReviewLogs(learnerId, {})).not.toContainEqual(
    expect.objectContaining({ conceptId: withdrawn.exercise.concept }),
  );
});

test('a retake leaves out a topic with no fresh question and still earns no XP', async () => {
  const context = await runtime();
  const store = memoryStore();
  const concepts = ['vectors', 'integrals'];
  const run = await store.insertTimedQuiz(
    learnerId,
    {
      seed: 1,
      difficulty: 2,
      plannedMinutes: 5,
      activityId: null,
      retakeOf: null,
      startedAt,
      deadline,
      finalizedAt: deadline,
      score: 0,
      xpAwarded: 0,
    },
    concepts.map((conceptId, position) => ({
      position,
      conceptId,
      question: question(conceptId),
      reserve: question(conceptId, 1),
      answeredAt: null,
      latencyMs: null,
      submission: null,
      correct: false,
      followUp: true,
      followUpActivityId: null,
    })),
  );
  const session = await store.insertSession(learnerId, sessionRow(deadline));
  const [review] = await store.insertActivities(learnerId, session.id, [
    activityRow(0, { kind: 'review', status: 'completed' }),
  ]);
  await store.linkTimedQuizFollowUps(learnerId, concepts, review.id);
  const revised = {
    ...context.content,
    exercisesById: new Map([['vectors-1', question('vectors', 1).exercise]]),
    exercisesByConcept: new Map(),
  };
  const now = new Date(+deadline + 1000);
  const started = await startQuizRetake(store, { ...context, content: revised, now }, run.id);
  expect(started).toMatchObject({
    kind: 'created',
    body: { retake: true, totalItems: 1, question: { exercise: { id: 'vectors-1' } } },
  });
  if (!('body' in started)) throw new Error('Retake did not start');
  const id = started.body.id;
  await answerQuiz(store, { ...context, content: revised, now }, id, {
    questionId: 'vectors-1',
    position: 0,
    answer: 42,
  });
  expect(await finalizeQuiz(store, { ...context, content: revised, now }, id)).toMatchObject({
    kind: 'ok',
    body: { result: { score: 1, xpAwarded: 0 } },
  });
  expect(await store.listXpEvents(learnerId, {})).toEqual([]);
});
