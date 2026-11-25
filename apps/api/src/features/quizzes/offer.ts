import type { ContentIndex } from '@academy/aesop/course/types';
import {
  nextQuizDifficulty,
  QUIZ_XP_INTERVAL,
  type QuizQuestionPair,
  quizPlannedMinutes,
  quizSeed,
  quizXpBalance,
  selectQuizQuestions,
} from '@academy/aesop/quizzes/mixed-quiz';
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { LearnerRepository } from '../../db/repository.js';
import { lessonRuns, quizItems, quizRuns, sessionActivities, xpEvents } from '../../db/schema.js';
import { confirmedPlacementTopicIds } from './confirmed-placement.js';

export type QuizRun = typeof quizRuns.$inferSelect;

export function quizAccommodation(prefs: unknown): number {
  const value = (prefs as { quizTimeMultiplier?: unknown } | null)?.quizTimeMultiplier;
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? value : 1;
}

export async function quizOffer(
  repo: LearnerRepository,
  content: ContentIndex,
  now: Date,
  courseId: string | null,
): Promise<{
  xpBalance: number;
  plannedMinutes?: number;
  active?: QuizRun;
  selection?: {
    questions: QuizQuestionPair[];
    difficulty: number;
    seed: number;
    accommodation: number;
  };
}> {
  const { db, userId } = repo;
  const [xp, originals, [active]] = await Promise.all([
    db
      .select({ amount: sql<number>`coalesce(sum(${xpEvents.amount}), 0)::int` })
      .from(xpEvents)
      .leftJoin(
        sessionActivities,
        sql`${xpEvents.sourceKey} = 'activity:' || ${sessionActivities.id}::text`,
      )
      .where(
        and(
          eq(xpEvents.userId, userId),
          lte(xpEvents.earnedAt, now),
          sql`(${xpEvents.kind} in ('knowledge_point', 'review') or
          (${xpEvents.kind} = 'activity' and ${sessionActivities.kind} in ('learn', 'review')))`,
        ),
      ),
    db
      .select({ id: quizRuns.id, difficulty: quizRuns.difficulty, score: quizRuns.score })
      .from(quizRuns)
      .where(
        and(eq(quizRuns.userId, userId), isNull(quizRuns.retakeOf), lte(quizRuns.finalizedAt, now)),
      )
      .orderBy(asc(quizRuns.finalizedAt), asc(quizRuns.startedAt), asc(quizRuns.seed)),
    db
      .select()
      .from(quizRuns)
      .where(and(eq(quizRuns.userId, userId), isNull(quizRuns.finalizedAt))),
  ]);
  const xpBalance = quizXpBalance(xp[0].amount, originals.length);
  if (active) return { xpBalance, active, plannedMinutes: active.plannedMinutes };
  if (xpBalance < QUIZ_XP_INTERVAL) return { xpBalance };

  const [lessons, confirmed, history, user] = await Promise.all([
    db
      .select({ topic: lessonRuns.conceptId })
      .from(lessonRuns)
      .where(
        and(
          eq(lessonRuns.userId, userId),
          eq(lessonRuns.status, 'completed'),
          lte(lessonRuns.completedAt, now),
        ),
      ),
    confirmedPlacementTopicIds(userId),
    db
      .select({
        topic: quizItems.conceptId,
        key: sql<string>`${quizItems.question}->>'key'`,
        reserve: sql<string | null>`${quizItems.reserve}->>'key'`,
        originalId: quizRuns.retakeOf,
        runId: quizRuns.id,
        correct: quizItems.correct,
      })
      .from(quizItems)
      .innerJoin(quizRuns, eq(quizItems.runId, quizRuns.id))
      .where(eq(quizRuns.userId, userId)),
    repo.user(),
  ]);
  const usedKeys = new Set(history.map(({ key }) => key));
  const exposure = new Map<string, number>();
  const missedOriginals = new Set(
    history
      .filter(({ originalId, correct }) => originalId === null && correct === false)
      .map(({ runId }) => runId),
  );
  for (const item of history) {
    exposure.set(item.topic, (exposure.get(item.topic) ?? 0) + 1);
    if (item.reserve && missedOriginals.has(item.runId)) usedKeys.add(item.reserve);
  }
  const previous = originals.at(-1);
  const difficulty = nextQuizDifficulty(
    previous?.score == null
      ? undefined
      : { difficulty: previous.difficulty, score: previous.score },
  );
  // Learner IDs vary between simulator runs. The history and course determine the seed.
  const seed = quizSeed(courseId ?? '', originals.length) & 0x7fffffff;
  const questions = selectQuizQuestions({
    content,
    completedTopics: new Set(lessons.map(({ topic }) => topic)),
    confirmedPlacementTopics: confirmed,
    courseId,
    seed,
    difficulty,
    exposure,
    usedKeys,
  });
  if (!questions) return { xpBalance };
  const accommodation = quizAccommodation(user?.prefs);
  return {
    xpBalance,
    plannedMinutes: quizPlannedMinutes(
      questions.map(({ question }) => question),
      accommodation,
    ),
    selection: { questions, difficulty, seed, accommodation },
  };
}
