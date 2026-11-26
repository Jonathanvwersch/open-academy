import type { QuizQuestion } from '../quizzes/mixed-quiz.js';
import type { Id, NewRow } from './core-store.js';
import type { PlacementReviewStore } from './placement-review-store.js';
import type { RowEdit } from './session-store.js';

export type TimedQuizRun = {
  id: Id;
  activityId: Id | null;
  retakeOf: Id | null;
  seed: number;
  difficulty: number;
  plannedMinutes: number;
  startedAt: Date;
  deadline: Date;
  finalizedAt: Date | null;
  score: number | null;
  xpAwarded: number | null;
};

export type TimedQuizItem = {
  runId: Id;
  position: number;
  conceptId: Id;
  question: QuizQuestion;
  reserve: QuizQuestion | null;
  answeredAt: Date | null;
  latencyMs: number | null;
  submission: {
    answer: unknown;
    correct: number;
    gradedBy: 'deterministic' | 'llm' | 'self';
  } | null;
  correct: boolean | null;
  followUp: boolean;
  followUpActivityId: Id | null;
};

export type TimedQuizQuery = {
  id?: Id;
  activityId?: Id;
  activityIds?: readonly Id[];
  retakeOf?: Id;
  active?: true;
  original?: true;
  finalizedThrough?: Date;
};

export type TimedQuizItemKey = {
  runId: Id;
  conceptId: Id;
  questionKey: string;
  reserveKey: string | null;
};

export function collectTimedQuizItemKeys(
  rows: Array<TimedQuizItemKey & { position: number; correct: boolean | null }>,
) {
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const missedRunIds = new Set<Id>();
  const items = rows
    .sort(
      (a, b) =>
        a.position - b.position ||
        compare(a.conceptId, b.conceptId) ||
        compare(a.questionKey, b.questionKey) ||
        compare(a.reserveKey ?? '', b.reserveKey ?? ''),
    )
    .map(({ runId, conceptId, questionKey, reserveKey, correct }) => {
      if (correct === false) missedRunIds.add(runId);
      return { runId, conceptId, questionKey, reserveKey };
    });
  return { items, missedRunIds };
}

export interface FlowStore extends PlacementReviewStore {
  sumQuizEligibleXp(
    learnerId: Id,
    through: Date,
    lastQuizAt?: Date,
  ): Promise<{ throughLastQuiz: number; sinceLastQuiz: number }>;
  listTimedQuizRuns(learnerId: Id, query: TimedQuizQuery): Promise<TimedQuizRun[]>;
  listTimedQuizItems(learnerId: Id, runIds: readonly Id[]): Promise<TimedQuizItem[]>;
  listTimedQuizItemKeys(
    learnerId: Id,
    runIds: readonly Id[],
  ): Promise<{ items: TimedQuizItemKey[]; missedRunIds: ReadonlySet<Id> }>;
  insertTimedQuiz(
    learnerId: Id,
    run: NewRow<TimedQuizRun>,
    items: readonly Omit<TimedQuizItem, 'runId'>[],
  ): Promise<TimedQuizRun>;
  patchTimedQuizRun(learnerId: Id, runId: Id, patch: RowEdit<TimedQuizRun>): Promise<TimedQuizRun>;
  patchTimedQuizItem(
    learnerId: Id,
    runId: Id,
    position: number,
    patch: Partial<Omit<TimedQuizItem, 'runId' | 'position'>>,
  ): Promise<void>;
  linkTimedQuizFollowUps(learnerId: Id, conceptIds: readonly Id[], activityId: Id): Promise<void>;
}
