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
  retakeOf?: Id;
  active?: true;
  original?: true;
  finalizedThrough?: Date;
};

export interface FlowStore extends PlacementReviewStore {
  listTimedQuizRuns(learnerId: Id, query: TimedQuizQuery): Promise<TimedQuizRun[]>;
  listTimedQuizItems(learnerId: Id, runIds: readonly Id[]): Promise<TimedQuizItem[]>;
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
