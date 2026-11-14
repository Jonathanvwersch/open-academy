import type { ClientExercise } from './exercises.js';

export interface PlacementStartPayload {
  id: string;
}

export type PlacementNextPayload =
  | { complete: true }
  | {
      complete: false;
      courseTitle: string;
      questionNumber: number;
      maxQuestions: number;
      exercise: ClientExercise;
    };

export interface PlacementResultsPayload {
  courseId: string;
  courseTitle: string;
  placedOut: string[];
  foundationsPlacedOut: string[];
  topicsTotal: number;
  topicsDone: number;
  firstTopic: string | null;
}

export type PlacementAnswerInput =
  | { exerciseId: string; answer: unknown }
  | { exerciseId: string; dontKnow: true };
