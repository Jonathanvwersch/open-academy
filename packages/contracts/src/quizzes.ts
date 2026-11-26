import type { ClientExercise } from './exercises.js';

export interface QuizAnswer {
  position: number;
  questionId?: string;
  answer: unknown;
}

export interface QuizPayload {
  id: string;
  sessionId?: string;
  startedAt: string;
  deadline: string;
  serverNow: string;
  totalItems: number;
  expired: boolean;
  retake: boolean;
  question: { position: number; number: number; exercise: ClientExercise } | null;
  result: {
    score: number;
    xpAwarded: number;
    topics: Array<{ conceptId: string; title: string; missed: boolean; reviewed: boolean }>;
    retake: { eligible: boolean; id?: string };
  } | null;
}
