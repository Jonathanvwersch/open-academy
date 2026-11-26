import type { ContentIndex } from '../course/types.js';
import { effectiveGrantStates } from '../placement/grants.js';
import type { FlowStore, TimedQuizRun } from '../store/flow-store.js';
import type { PlacementReviewStore } from '../store/placement-review-store.js';
import type { SessionStore } from '../store/session-store.js';
import {
  nextQuizDifficulty,
  QUIZ_XP_INTERVAL,
  type QuizQuestionPair,
  quizPlannedMinutes,
  quizSeed,
  quizXpBalance,
  selectQuizQuestions,
} from './mixed-quiz.js';

export async function quizQuestionHistory(store: FlowStore, learnerId: string) {
  const runs = await store.listTimedQuizRuns(learnerId, {});
  const items = await store.listTimedQuizItems(
    learnerId,
    runs.map(({ id }) => id),
  );
  const originalIds = new Set(runs.filter(({ retakeOf }) => retakeOf === null).map(({ id }) => id));
  const missedOriginals = new Set(
    items
      .filter(({ runId, correct }) => correct === false && originalIds.has(runId))
      .map(({ runId }) => runId),
  );
  const usedKeys = new Set<string>();
  const exposure = new Map<string, number>();
  for (const { runId, conceptId, question, reserve } of items) {
    usedKeys.add(question.key);
    for (const key of question.previousKeys ?? []) usedKeys.add(key);
    if (question.withdrawn) continue;
    exposure.set(conceptId, (exposure.get(conceptId) ?? 0) + 1);
    if (reserve && missedOriginals.has(runId)) usedKeys.add(reserve.key);
  }
  return { items, usedKeys, exposure };
}

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

async function eligibleXp(store: SessionStore, learnerId: string, now: Date) {
  const events = await store.listXpEvents(learnerId, { through: now });
  const prefix = 'activity:';
  const ids = [
    ...new Set(
      events
        .filter(({ kind, sourceKey }) => kind === 'activity' && sourceKey.startsWith(prefix))
        .map(({ sourceKey }) => sourceKey.slice(prefix.length)),
    ),
  ];
  const activities = ids.length ? await store.listActivities(learnerId, { ids }) : [];
  const activityKeys = new Set(
    activities
      .filter(({ kind }) => kind === 'learn' || kind === 'review')
      .map(({ id }) => `${prefix}${id}`),
  );
  return events.reduce(
    (total, { kind, amount, sourceKey }) =>
      kind === 'knowledge_point' ||
      kind === 'review' ||
      (kind === 'activity' && activityKeys.has(sourceKey))
        ? total + amount
        : total,
    0,
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
  const [xp, originals, [active]] = await Promise.all([
    eligibleXp(store, learnerId, now),
    store.listTimedQuizRuns(learnerId, { original: true, finalizedThrough: now }),
    store.listTimedQuizRuns(learnerId, { active: true }),
  ]);
  const xpBalance = quizXpBalance(xp, originals.length);
  if (active) return { xpBalance, active, plannedMinutes: active.plannedMinutes };
  if (xpBalance < QUIZ_XP_INTERVAL) return { xpBalance };

  const [lessons, confirmedPlacementTopics, history, learnerSettings] = await Promise.all([
    store.listLessonRuns(learnerId),
    confirmedPlacementTopicIds(store, learnerId),
    quizQuestionHistory(store, learnerId),
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
    completedTopics,
    confirmedPlacementTopics,
    courseId,
    seed,
    difficulty,
    exposure: history.exposure,
    usedKeys: history.usedKeys,
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
