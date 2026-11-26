import type { ContentIndex } from '../course/types.js';
import { effectiveGrantStates } from '../placement/grants.js';
import type { FlowStore, TimedQuizRun } from '../store/flow-store.js';
import type { PlacementReviewStore } from '../store/placement-review-store.js';
import {
  nextQuizDifficulty,
  QUIZ_XP_INTERVAL,
  type QuizQuestionPair,
  quizPlannedMinutes,
  quizSeed,
  quizXpBalance,
  selectQuizQuestions,
} from './mixed-quiz.js';

export function quizAccommodation(prefs: unknown): number {
  const value = (prefs as { quizTimeMultiplier?: unknown } | null)?.quizTimeMultiplier;
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? value : 1;
}

export async function confirmedPlacementTopicIds(
  store: PlacementReviewStore,
  learnerId: string,
): Promise<ReadonlySet<string>> {
  const grants = await store.listPlacementGrants(learnerId, {
    excludeReasons: ['legacy_confirmed', 'legacy_provisional'],
  });
  return new Set(
    [...effectiveGrantStates(grants)]
      .filter(([, state]) => state === 'confirmed')
      .map(([id]) => id),
  );
}

export async function quizOffer(
  store: FlowStore,
  learnerId: string,
  content: ContentIndex,
  now: Date,
  courseId: string | null,
  settings?: { prefs: unknown } | null,
): Promise<{
  xpBalance: number;
  plannedMinutes?: number;
  active?: TimedQuizRun;
  selection?: {
    questions: QuizQuestionPair[];
    difficulty: number;
    seed: number;
    accommodation: number;
  };
}> {
  const [originals, [active]] = await Promise.all([
    store.listTimedQuizRuns(learnerId, { original: true, finalizedThrough: now }),
    store.listTimedQuizRuns(learnerId, { active: true }),
  ]);
  const previous = originals.at(-1);
  const { throughLastQuiz, sinceLastQuiz } = await store.sumQuizEligibleXp(
    learnerId,
    now,
    previous?.finalizedAt ?? undefined,
  );
  const xpBalance = quizXpBalance(throughLastQuiz + sinceLastQuiz, originals.length);
  if (active) return { xpBalance, active, plannedMinutes: active.plannedMinutes };
  if (xpBalance < QUIZ_XP_INTERVAL) return { xpBalance };

  const [lessons, confirmedPlacementTopics, history, learnerSettings] = await Promise.all([
    store.listLessonRuns(learnerId),
    confirmedPlacementTopicIds(store, learnerId),
    store.listTimedQuizRuns(learnerId, {}).then(async (runs) => {
      const { items, missedRunIds } = await store.listTimedQuizItemKeys(
        learnerId,
        runs.map(({ id }) => id),
      );
      const missedOriginals = new Set(
        runs
          .filter(({ id, retakeOf }) => retakeOf === null && missedRunIds.has(id))
          .map(({ id }) => id),
      );
      return { items, missedOriginals };
    }),
    settings === undefined ? store.getSettings(learnerId) : settings,
  ]);
  const completedTopics = new Set(
    lessons
      .filter(
        ({ status, completedAt }) =>
          status === 'completed' && completedAt !== null && completedAt <= now,
      )
      .map(({ conceptId }) => conceptId),
  );
  const usedKeys = new Set(history.items.map(({ questionKey }) => questionKey));
  const exposure = new Map<string, number>();
  for (const item of history.items) {
    exposure.set(item.conceptId, (exposure.get(item.conceptId) ?? 0) + 1);
    if (item.reserveKey !== null && history.missedOriginals.has(item.runId)) {
      usedKeys.add(item.reserveKey);
    }
  }
  const difficulty = nextQuizDifficulty(
    previous?.score == null
      ? undefined
      : { difficulty: previous.difficulty, score: previous.score },
  );
  // Learner IDs vary between simulator runs. The history and course determine the seed.
  const seed = quizSeed(courseId ?? '', originals.length) & 0x7fffffff;
  const questions = selectQuizQuestions({
    content,
    completedTopics,
    confirmedPlacementTopics,
    courseId,
    seed,
    difficulty,
    exposure,
    usedKeys,
  });
  if (!questions) return { xpBalance };
  const accommodation = quizAccommodation(learnerSettings?.prefs);
  return {
    xpBalance,
    plannedMinutes: quizPlannedMinutes(
      questions.map(({ question }) => question),
      accommodation,
    ),
    selection: { questions, difficulty, seed, accommodation },
  };
}
