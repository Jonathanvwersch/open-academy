export type LessonBlockKind =
  | 'objective'
  | 'fits'
  | 'intuition'
  | 'example'
  | 'math'
  | 'worked'
  | 'check'
  | 'faded'
  | 'summary'
  | 'tldr';

import type { AnswerOptions, ClientExercise, ExercisePayload } from '@academy/contracts/exercises';

export interface LessonPayload {
  where_this_fits?: string;
  prerequisites?: LessonPrerequisite[];
  final?: string;
  blocks: Array<{ kind: LessonBlockKind; md?: string; exercise?: string }>;
  knowledge_points?: Array<{
    id: string;
    title: string;
    tldr?: string;
    explain: string;
    worked: string;
    problems: string[];
  }>;
}

export interface LessonReviewPayload {
  course: LessonCourse | null;
  canRestart: boolean;
  lesson: LessonPayload;
  checkAnswers: Record<string, string>;
  checks: Record<string, ExercisePayload>;
  runStatus: NonNullable<LessonRunPayload['run']>['status'] | null;
  conceptTitle: string;
}

export interface LessonRunPayload {
  course: LessonCourse | null;
  run: null | {
    id: string;
    needsProgressSync?: boolean;
    status: 'in_progress' | 'needs_retry' | 'quiz' | 'completed';
    halted?: { pointId: string; index: number };
    retry?: {
      after: string | null;
      ready: boolean;
      reviewFirst: Array<{ id: string; title: string }>;
    };
    where_this_fits?: string;
    prerequisites?: LessonPrerequisite[];
    points: Array<{
      id: string;
      status: 'passed' | 'failed' | 'active' | 'locked';
      round: number;
      answered: number;
      streak: number;
      xpEarned: number;
    }>;
    currentPointId: string | null;
    currentPoint?: { id: string; title: string; tldr?: string; explain: string; worked: string };
    pending?: {
      id: string;
      knowledgePointId: string;
      round: number;
      position: number;
      exerciseId: string;
      seed: number | null;
    };
    pendingProblem?: {
      id: string;
      knowledgePointId: string;
      round: number;
      position: number;
      exerciseId: string;
      seed: number | null;
      exercise: ClientExercise;
    };
    pendingPracticeProblem?: {
      id: string;
      knowledgePointId: string;
      round: number;
      position: number;
      exerciseId: string;
      seed: number | null;
      practiceOnly: true;
      exercise: ClientExercise;
    };
    lastAnswered?: {
      id: string;
      knowledgePointId: string;
      correct: number | null;
      round: number;
      position: number;
    };
    lastAnsweredProblem?: {
      id: string;
      knowledgePointId: string;
      exerciseId: string;
      correct: number | null;
      round: number;
      position: number;
      practiceOnly?: boolean;
      activityId?: string | null;
      exercise: ClientExercise;
      result: {
        correct: number | null;
        attemptNo: number;
        feedback: string;
        solution: string;
        yourAnswer: string;
        correctAnswer: string;
        answerOptions?: AnswerOptions;
      };
    };
    xpEarned: number;
    quiz: {
      status: 'not_started' | 'in_progress' | 'failed' | 'passed';
      passMark: number;
      questionCount: number;
      reviewRequired: Array<{
        pointId: string;
        title: string;
        answered: number;
        needed: 3;
      }>;
      current?: {
        attemptId: string;
        items: Array<{
          id: string;
          position: number;
          exercise: ClientExercise | null;
          answered: boolean;
          answer?: unknown;
          locked?: boolean;
        }>;
      };
      last?: {
        attemptId: string;
        attemptNo: number;
        score: number;
        correctCount: number;
        total: number;
        passed: boolean;
        perStep: Array<{ pointId: string; title: string; correct: number; total: number }>;
      };
      bestPassed: boolean;
      xpAwarded: number;
    };
  };
}

export interface LessonRunAnswerPayload {
  correct: number;
  feedback: string;
  solution: string;
  xpAwarded: number;
  state: NonNullable<LessonRunPayload['run']>;
}

export type LessonPrerequisite = { id: string; title: string; recap?: string };
export type LessonCourse = {
  id: string;
  title: string;
  unitNumber: number;
  unitTitle: string;
  position: string;
};

export type QuizReviewPayload = {
  attemptId: string;
  items: Array<{
    id: string;
    position: number;
    pointId: string;
    title: string;
    exercise: { prompt: string; type: string; target_seconds?: number };
    yourAnswer: string;
    correctAnswer: string;
    solution: string;
    correct: number | null;
    durationMs?: number | null;
  }>;
};
