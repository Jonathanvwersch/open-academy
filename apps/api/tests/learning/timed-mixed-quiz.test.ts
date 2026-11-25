import { newReviewCard } from '@academy/aesop/memory/fsrs';
import type { QuizQuestion } from '@academy/aesop/quizzes/mixed-quiz';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, expect, test } from 'vitest';
import { env } from '../../src/config.js';
import { loadContent } from '../../src/content/load.js';
import { createDb } from '../../src/db/client.js';
import { LearnerRepository } from '../../src/db/repository.js';
import {
  attempts,
  diagnosticRuns,
  placementGrants,
  quizItems,
  quizRuns,
  reviewCards,
  reviewLogs,
  sessionActivities,
  topicSpeed,
  users,
} from '../../src/db/schema.js';
import { confirmedPlacementTopicIds } from '../../src/features/quizzes/confirmed-placement.js';
import {
  answerQuiz,
  finalizeQuiz,
  startQuizFollowUps,
} from '../../src/features/quizzes/service.js';

const db = createDb(env.TEST_DATABASE_URL);
const learners: string[] = [];

async function createLearner() {
  const [{ id }] = await db
    .insert(users)
    .values({ displayName: 'Mixed quiz learner', activeCourseId: 'maths-for-ml', timezone: 'UTC' })
    .returning();
  learners.push(id);
  return id;
}

afterAll(async () => {
  try {
    await db.delete(users).where(inArray(users.id, learners));
  } finally {
    await db.$client.end();
  }
});

test('mixed quizzes use only effective confirmed, non-legacy grants for the learner', async () => {
  const userId = await createLearner();
  const otherUserId = await createLearner();
  const [first, second, other] = await db
    .insert(diagnosticRuns)
    .values([{ userId }, { userId }, { userId: otherUserId }])
    .returning({ id: diagnosticRuns.id });
  const day = new Date('2026-01-14');
  await db.insert(placementGrants).values([
    {
      userId,
      runId: first.id,
      conceptId: 'confirmed',
      origin: 'direct',
      state: 'confirmed',
      reason: 'on_time',
      createdAt: day,
    },
    {
      userId,
      runId: second.id,
      conceptId: 'confirmed',
      origin: 'inferred',
      state: 'conditional',
      reason: 'inferred_only',
      createdAt: new Date('2026-01-15'),
    },
    {
      userId,
      runId: first.id,
      conceptId: 'conditional',
      origin: 'direct',
      state: 'conditional',
      reason: 'slow',
    },
    {
      userId,
      runId: first.id,
      conceptId: 'withdrawn',
      origin: 'inferred',
      state: 'withdrawn',
      reason: 'cascade',
    },
    {
      userId,
      runId: first.id,
      conceptId: 'legacy',
      origin: 'inferred',
      state: 'confirmed',
      reason: 'legacy_confirmed',
    },
    {
      userId: otherUserId,
      runId: other.id,
      conceptId: 'another-learner',
      origin: 'direct',
      state: 'confirmed',
      reason: 'on_time',
    },
  ]);

  expect(await confirmedPlacementTopicIds(db, userId)).toEqual(new Set(['confirmed']));
});

test.each([false, true])(
  'quiz finalization skips a suspended card when correct is %s',
  async (correct) => {
    const userId = await createLearner();
    const content = await loadContent('content');
    const now = new Date('2026-01-14T12:00:00.000Z');
    const startedAt = new Date('2026-01-14T11:55:00.000Z');
    const dueAt = new Date('2026-01-18T12:00:00.000Z');
    const questionFor = (conceptId: string): QuizQuestion => {
      const exercise = content.exercisesByConcept
        .get(conceptId)
        ?.find(
          (exercise) =>
            exercise.dimension === 'conceptual' &&
            (exercise.type === 'mc' ||
              exercise.type === 'numeric' ||
              exercise.type === 'expression'),
        );
      if (!exercise) throw new Error(`No conceptual quiz exercise for ${conceptId}`);
      return { exercise: exercise as QuizQuestion['exercise'], seed: 0, key: exercise.id };
    };
    const missed = questionFor('vectors');
    const active = questionFor('derivatives');
    const [suspendedCard, otherDimension, activeCard] = await db
      .insert(reviewCards)
      .values([
        {
          userId,
          conceptId: 'vectors',
          dimension: missed.exercise.dimension,
          fsrs: newReviewCard(dueAt),
          dueAt,
          suspendedAt: startedAt,
        },
        { userId, conceptId: 'vectors', dimension: 'math', fsrs: newReviewCard(dueAt), dueAt },
        {
          userId,
          conceptId: 'derivatives',
          dimension: active.exercise.dimension,
          fsrs: newReviewCard(dueAt),
          dueAt,
        },
      ])
      .returning();
    const [run] = await db
      .insert(quizRuns)
      .values({ userId, seed: 0, difficulty: 2, plannedMinutes: 5, startedAt, deadline: now })
      .returning();
    await db.insert(quizItems).values([
      {
        runId: run.id,
        position: 0,
        conceptId: 'vectors',
        question: missed,
        answeredAt: startedAt,
        latencyMs: 1000,
        correct,
        submission: { answer: 'submitted', correct: Number(correct), gradedBy: 'deterministic' },
      },
      { runId: run.id, position: 1, conceptId: 'derivatives', question: active },
    ]);
    const deps = { db, content: async () => content, tutorProvider: null };
    const request = {
      userId,
      timeZone: 'UTC',
      params: { id: run.id },
      query: {},
      body: undefined,
      repo: new LearnerRepository(db, userId),
      tutor: null,
      now: () => now,
    };

    const blank = await answerQuiz(deps, {
      ...request,
      body: { position: 1, answer: '' },
      now: () => startedAt,
    });
    expect(blank.status).toBe(422);
    const finalized = await finalizeQuiz(deps, request);
    expect(finalized.status).toBe(200);
    expect(finalized.body).toMatchObject({ result: { score: correct ? 0.5 : 0 } });
    const cards = await db.select().from(reviewCards).where(eq(reviewCards.userId, userId));
    expect(cards.find((card) => card.id === suspendedCard.id)).toEqual(suspendedCard);
    expect(cards.find((card) => card.id === otherDimension.id)).toEqual(otherDimension);
    expect(cards.find((card) => card.id === activeCard.id)?.dueAt).toEqual(now);
    const logs = await db
      .select({ cardId: reviewLogs.cardId })
      .from(reviewLogs)
      .where(inArray(reviewLogs.cardId, [suspendedCard.id, otherDimension.id, activeCard.id]));
    expect(logs).toEqual([{ cardId: activeCard.id }]);
    expect(await finalizeQuiz(deps, request)).toEqual(finalized);
    expect(await db.select().from(attempts).where(eq(attempts.userId, userId))).toEqual([
      expect.objectContaining({ conceptId: 'vectors', correct: Number(correct) }),
    ]);
    expect(await db.select().from(topicSpeed).where(eq(topicSpeed.userId, userId))).toEqual([
      expect.objectContaining({
        conceptId: 'vectors',
        answers: 1,
        trials: 1,
        successes: Number(correct),
      }),
    ]);

    const followUps = await startQuizFollowUps(deps, request);
    expect(followUps.status).toBe(201);
    if (!('sessionId' in followUps.body)) throw new Error('Missing follow-up session');
    const activities = await db
      .select({ conceptId: sessionActivities.conceptId })
      .from(sessionActivities)
      .where(eq(sessionActivities.sessionId, followUps.body.sessionId));
    expect(activities).toEqual([{ conceptId: 'derivatives' }]);
  },
);
