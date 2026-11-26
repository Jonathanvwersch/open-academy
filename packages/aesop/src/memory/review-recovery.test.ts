import { fileURLToPath } from 'node:url';
import { Rating, State } from 'ts-fsrs';
import { expect, test } from 'vitest';
import { loadContentFromDirectory } from '../course/load.js';
import type { ContentIndex } from '../course/types.js';
import {
  buildReviewActivityForConcept,
  mixReviewActivities,
  type SchedulerState,
} from '../planner/scheduler.js';
import { updateSessionProgress } from '../planner/session-progress.js';
import { recoverReviewActivities } from '../planner/session-state.js';
import { activityRow, sessionRow } from '../store/learner-store.contract.js';
import { memoryStore } from '../store/memory-store.js';
import { prepareExerciseAttempt, recordExerciseAttempt } from './exercise-attempts.js';
import { newReviewCard } from './fsrs.js';
import { implicitRepetition } from './implicit-repetition.js';

const userId = 'learner';
const now = new Date('2026-01-17T12:00:00Z');
const dueAt = new Date('2026-01-16T12:00:00Z');
const content = loadContentFromDirectory(
  fileURLToPath(new URL('../../../../tests/fixtures/content', import.meta.url)),
);

function withoutQuestions(index: ContentIndex, removed: readonly string[]): ContentIndex {
  const keep = ({ id }: { id: string }) => !removed.includes(id);
  return {
    ...index,
    exercisesById: new Map([...index.exercisesById].filter(([, exercise]) => keep(exercise))),
    exercisesByConcept: new Map(
      [...index.exercisesByConcept].map(([id, exercises]) => [id, exercises.filter(keep)]),
    ),
    exercisesByRole: new Map(
      [...index.exercisesByRole].map(([id, exercises]) => [id, exercises.filter(keep)]),
    ),
  };
}

async function reviewFixture() {
  const store = memoryStore();
  const savedSession = await store.insertSession(userId, sessionRow(now));
  let index = await content;
  let clock = now;
  let ids = 0;
  const schedulerState = async (): Promise<SchedulerState> => ({
    activeCourseId: null,
    studyCourseIds: [],
    recentLearnMinutesByConcept: {},
    mastery: [],
    cards: (await store.listReviewCards(userId)).map((card) => ({
      ...card,
      dueAt: card.dueAt.toISOString(),
    })),
    reviewedTodayConceptIds: (await store.listReviewLogs(userId, {}))
      .filter(
        (log) => log.createdAt.toISOString().slice(0, 10) === clock.toISOString().slice(0, 10),
      )
      .map((log) => log.conceptId),
    recentAttempts: [],
    exerciseLastSeen: new Map(),
    remediationFlags: [],
    projectProgress: [],
    completedPaperIds: [],
    startDate: '2026-01-01',
  });
  const session = async () => {
    const activities = await store.listActivities(userId, { sessionIds: [savedSession.id] });
    await recoverReviewActivities(store, userId, activities, index, clock, schedulerState);
    return { ...savedSession, userId, activities };
  };
  const runtime = {
    now: () => clock,
    newId: () => `attempt-${++ids}`,
    enableFsrsFuzz: false,
    session,
    schedulerState,
  };
  return {
    store,
    schedulerState,
    session,
    setClock: (date: Date) => {
      clock = date;
    },
    remove: (ids: string[]) => {
      index = withoutQuestions(index, ids);
      return index;
    },
    addReview: async (
      exerciseIds: string[],
      overrides: Pick<NonNullable<Parameters<typeof activityRow>[1]>, 'conceptId' | 'reason'>,
      idx = 0,
    ) => {
      const [review] = await store.insertActivities(userId, savedSession.id, [
        activityRow(idx, { kind: 'review', status: 'in_progress', exerciseIds, ...overrides }),
      ]);
      return review;
    },
    addCard: async (conceptId: string, dimension: 'conceptual' | 'math', mature = false) => {
      const lastReviewAt = new Date('2026-01-01T12:00:00Z');
      const fsrs = mature
        ? {
            ...newReviewCard(dueAt),
            state: State.Review,
            last_review: lastReviewAt,
            stability: 12,
            difficulty: 5,
            reps: 8,
          }
        : newReviewCard(dueAt);
      return store.insertReviewCard(userId, {
        conceptId,
        dimension,
        fsrs,
        dueAt,
        lastReviewAt: mature ? lastReviewAt : null,
        reps: fsrs.reps,
        lapses: fsrs.lapses,
      });
    },
    answer: async (activityId: string, exerciseId: string, durationMs = 1000) => {
      const exercise = index.exercisesById.get(exerciseId);
      if (!exercise) throw new Error(`Missing exercise: ${exerciseId}`);
      const prepared = await prepareExerciseAttempt(
        store,
        userId,
        index,
        exercise,
        { activityId, mode: 'review', answer: 'submitted answer', durationMs },
        session,
      );
      if (prepared.kind !== 'ready') throw new Error(JSON.stringify(prepared));
      return recordExerciseAttempt(
        store,
        runtime,
        prepared,
        { correct: 1, feedback: 'Correct', gradedBy: 'deterministic' },
        'UTC',
      );
    },
    continueReview: (activityId: string) =>
      updateSessionProgress(
        store,
        userId,
        savedSession.id,
        activityId,
        { complete: true },
        runtime.now,
        'UTC',
        false,
        {
          content: async () => index,
          session,
          schedulerState,
          attemptedExerciseIdsByActivity: async () =>
            new Map([
              [
                activityId,
                new Set(
                  (await store.listAttempts(userId, { activityIds: [activityId] })).map(
                    (attempt) => attempt.exerciseId,
                  ),
                ),
              ],
            ]),
          replanBlocked: async () => {
            throw new Error('A review should not replan blocked lessons');
          },
        },
      ),
  };
}

test.each(['all', 'one topic'] as const)(
  'recovers the original mixed review topics when %s of the scheduled questions disappear',
  async (deleted) => {
    const fixture = await reviewFixture();
    const index = await content;
    const topics = ['supervised-learning', 'vectors'];
    await fixture.addCard('derivatives', 'conceptual');
    await fixture.addCard('supervised-learning', 'conceptual');
    await fixture.addCard('vectors', 'math');
    const state = await fixture.schedulerState();
    const candidates = topics.map((topic) => {
      const activity = buildReviewActivityForConcept(state, index, now, topic);
      if (!activity) throw new Error(`No review for ${topic}`);
      return { activity, score: 1, adjustedMinutes: activity.plannedMinutes, newConcept: false };
    });
    const [{ activity }] = mixReviewActivities(candidates, index);
    expect(activity.conceptId).toBeNull();
    await fixture.addReview(activity.exerciseIds, { conceptId: null, reason: activity.reason });
    const removed = deleted === 'all' ? activity.exerciseIds : candidates[0].activity.exerciseIds;
    const revised = fixture.remove(removed);
    for (const topic of topics) {
      expect(buildReviewActivityForConcept(state, revised, now, topic)).toBeDefined();
    }

    const {
      activities: [recovered],
    } = await fixture.session();
    expect(recovered.exerciseIds.filter((id) => removed.includes(id))).toEqual([]);
    expect(
      [
        ...new Set(recovered.exerciseIds.map((id) => revised.exercisesById.get(id)?.concept)),
      ].sort(),
    ).toEqual([...topics].sort());
    expect(recovered.reason).toMatchObject({ topicIds: expect.arrayContaining(topics) });
  },
);

test.each(['unanswered question', 'answered and unanswered questions'] as const)(
  'rates saved review evidence after deletion of %s when an answer on another card finishes the review',
  async (deletion) => {
    const fixture = await reviewFixture();
    const answered = 'sl-classify-vs-regress';
    const pending = 'sl-review-ingredients';
    const last = 'vectors-dot-product';
    const first = await fixture.addCard('supervised-learning', 'conceptual');
    await fixture.addCard('vectors', 'conceptual');
    const review = await fixture.addReview([answered, pending, last], { conceptId: null });
    const answer = await fixture.answer(
      review.id,
      answered,
      deletion === 'unanswered question' ? undefined : 60 * 60_000,
    );
    expect(answer.activityCompleted).toBe(false);
    expect(await fixture.store.listReviewLogs(userId, { cardIds: [first.id] })).toEqual([]);
    fixture.remove(deletion === 'unanswered question' ? [pending] : [answered, pending]);

    expect((await fixture.answer(review.id, last)).activityCompleted).toBe(true);
    expect(await fixture.store.listReviewLogs(userId, { cardIds: [first.id] })).toMatchObject([
      { attemptId: answer.attemptId, rating: Rating.Good },
    ]);
    const scheduled = await fixture.store.getReviewCard(userId, first.conceptId, first.dimension);
    expect(Number(scheduled?.dueAt)).toBeGreaterThan(Number(now));
  },
);

test.each(['with backfill', 'without backfill'] as const)(
  'applies FIRe exactly once on Continue after deletion (%s)',
  async (completion) => {
    const fixture = await reviewFixture();
    const topic = 'derivatives';
    const math = 'derivatives-power-rule';
    const conceptual = 'derivatives-explain';
    const unanswered = 'derivatives-fixture-1-basics';
    const prerequisite = await fixture.addCard('vectors', 'math', true);
    const mathCard = await fixture.addCard(topic, 'math');
    await fixture.addCard(topic, 'conceptual');
    const backfill = completion === 'with backfill';
    const review = await fixture.addReview(
      backfill ? [math, conceptual, unanswered] : [math, conceptual],
      {
        conceptId: topic,
      },
    );
    await fixture.answer(review.id, math);
    if (backfill) await fixture.answer(review.id, conceptual);
    expect(await fixture.store.listReviewLogs(userId, { activityId: review.id })).toMatchObject([
      { conceptId: topic, cardId: mathCard.id, rating: Rating.Good },
    ]);
    expect(await fixture.store.getReviewCard(userId, 'vectors', 'math')).toEqual(prerequisite);
    fixture.remove(backfill ? [math, unanswered] : [conceptual]);
    const once = implicitRepetition(prerequisite, {
      now,
      timeZone: 'UTC',
      enableFuzz: false,
      weight: 0.5,
      rating: Rating.Good,
      speed: 1,
    });
    if (!once) throw new Error('Expected a positive FIRe adjustment');

    for (let i = 0; i < 2; i++) {
      expect(await fixture.continueReview(review.id)).toMatchObject({
        kind: 'ok',
        body: { status: 'completed' },
      });
      expect(await fixture.store.getReviewCard(userId, 'vectors', 'math')).toMatchObject({
        dueAt: once.dueAt,
      });
    }
  },
);

test('Continue awards earned review XP once even when none of the saved questions can be served', async () => {
  const fixture = await reviewFixture();
  const topic = 'derivatives';
  const answered = 'derivatives-power-rule';
  const pending = 'derivatives-explain';
  const mathCard = await fixture.addCard(topic, 'math');
  await fixture.addCard(topic, 'conceptual');
  const review = await fixture.addReview([answered, pending], { conceptId: topic });
  expect((await fixture.answer(review.id, answered)).activityCompleted).toBe(false);
  expect(await fixture.store.listReviewLogs(userId, { activityId: review.id })).toMatchObject([
    { cardId: mathCard.id, rating: Rating.Good },
  ]);
  fixture.remove([answered, pending]);

  for (let i = 0; i < 2; i++) {
    expect(await fixture.continueReview(review.id)).toMatchObject({
      kind: 'ok',
      body: { status: 'completed', exerciseIds: [] },
    });
  }
  expect(await fixture.store.listAttempts(userId, { activityIds: [review.id] })).toHaveLength(1);
  expect(await fixture.store.listXpEvents(userId, {})).toMatchObject([
    { sourceKey: `activity:${review.id}`, amount: review.plannedMinutes },
  ]);
});

test('an empty recovered review with no answers keeps its due date and earns no XP', async () => {
  const fixture = await reviewFixture();
  const topic = 'derivatives';
  const exercise = 'derivatives-power-rule';
  const card = await fixture.addCard(topic, 'math');
  const review = await fixture.addReview([exercise], { conceptId: topic });
  const index = await content;
  fixture.remove((index.exercisesByConcept.get(topic) ?? []).map(({ id }) => id));
  expect(await fixture.continueReview(review.id)).toMatchObject({
    kind: 'ok',
    body: { status: 'completed', exerciseIds: [] },
  });
  expect(await fixture.store.getReviewCard(userId, topic, 'math')).toEqual(card);
  expect(await fixture.store.listXpEvents(userId, {})).toEqual([]);
});

test('a replacement question in a new dimension cannot apply FIRe again for the same review topic', async () => {
  const fixture = await reviewFixture();
  const topic = 'derivatives';
  const answered = 'derivatives-explain';
  const pending = 'vectors-dot-product';
  const prerequisite = await fixture.addCard('vectors', 'math', true);
  await fixture.addCard(topic, 'conceptual');
  const mathCard = await fixture.addCard(topic, 'math');
  const nextWeek = new Date('2026-01-24T12:00:00Z');
  await fixture.store.patchReviewCard(userId, mathCard.id, { dueAt: nextWeek });
  await fixture.addCard('vectors', 'conceptual');
  const review = await fixture.addReview([answered, pending], { conceptId: null });
  expect((await fixture.answer(review.id, answered)).activityCompleted).toBe(false);
  const once = await fixture.store.getReviewCard(userId, 'vectors', 'math');
  expect(Number(once?.dueAt)).toBeGreaterThan(Number(prerequisite.dueAt));

  fixture.setClock(nextWeek);
  const revised = fixture.remove([answered, pending]);
  const {
    activities: [recovered],
  } = await fixture.session();
  const replacements = recovered.exerciseIds.filter(
    (id) => revised.exercisesById.get(id)?.concept === topic,
  );
  expect(new Set(replacements.map((id) => revised.exercisesById.get(id)?.dimension))).toEqual(
    new Set(['conceptual', 'math']),
  );
  for (const id of replacements) await fixture.answer(review.id, id);
  expect(await fixture.store.getReviewCard(userId, 'vectors', 'math')).toEqual(once);
});

test('a legacy review does not repeat FIRe already earned before a question was deleted', async () => {
  const fixture = await reviewFixture();
  const answered = 'derivatives-explain';
  const pending = 'vectors-dot-product';
  const prerequisite = await fixture.addCard('vectors', 'math', true);
  await fixture.addCard('derivatives', 'conceptual');
  const review = await fixture.addReview([answered, pending], { conceptId: null });
  await fixture.answer(review.id, answered);
  const credited = await fixture.store.getReviewCard(userId, 'vectors', 'math');
  expect(Number(credited?.dueAt)).toBeGreaterThan(Number(prerequisite.dueAt));
  await fixture.store.patchActivities(userId, { ids: [review.id] }, { reason: {} });

  fixture.remove([answered]);
  expect((await fixture.answer(review.id, pending)).activityCompleted).toBe(true);
  expect(await fixture.store.getReviewCard(userId, 'vectors', 'math')).toEqual(credited);
});

test('review recovery reserves a later review’s original topic before filling spare slots', async () => {
  const fixture = await reviewFixture();
  const index = await content;
  const earlyTopic = 'supervised-learning';
  const laterTopic = 'vectors';
  await fixture.addCard(earlyTopic, 'conceptual');
  await fixture.addCard(laterTopic, 'math');
  const earlyQuestions = (index.exercisesByConcept.get(earlyTopic) ?? []).map(({ id }) => id);
  const [survivor, ...removed] = earlyQuestions;
  const laterQuestion = 'vectors-dot-product';
  await fixture.addReview([survivor, removed[0]], {
    conceptId: null,
    reason: { topicIds: [earlyTopic] },
  });
  await fixture.addReview(
    [laterQuestion],
    { conceptId: null, reason: { topicIds: [laterTopic] } },
    1,
  );
  const revised = fixture.remove([...removed, laterQuestion]);
  const {
    activities: [first, second],
  } = await fixture.session();
  expect(first.exerciseIds).toEqual([survivor]);
  expect(second.exerciseIds).toHaveLength(1);
  expect(revised.exercisesById.get(second.exerciseIds[0])?.concept).toBe(laterTopic);
});
