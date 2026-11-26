import type { ContentIndex } from '../course/types.js';
import type { gradeExercise } from '../lessons/grading/index.js';
import type { CourseStore } from '../store/course-store.js';
import type { EngineLearnerRepository } from './repository.js';

export type EngineResult = {
  status: 200 | 201 | 400 | 403 | 404 | 409 | 422;
  body: unknown;
};

export type EngineOperation =
  | { kind: 'today' }
  | { kind: 'learn' }
  | { kind: 'courseCatalog' }
  | { kind: 'course'; courseId: string }
  | { kind: 'setActiveCourse'; body: Record<string, unknown> }
  | { kind: 'startCourse'; courseId: string; body: Record<string, unknown> }
  | { kind: 'createSession'; body: Record<string, unknown> }
  | { kind: 'session'; sessionId: string }
  | { kind: 'replanSession'; sessionId: string }
  | { kind: 'endSession'; sessionId: string }
  | {
      kind: 'activityProgress';
      sessionId: string;
      activityId: string;
      body: Record<string, unknown>;
    }
  | { kind: 'startLessonRun'; conceptId: string; body: { activityId: string } }
  | { kind: 'practiceLessonPoint'; conceptId: string; body: Record<string, unknown> }
  | { kind: 'answerLessonProblem'; conceptId: string; body: Record<string, unknown> }
  | { kind: 'startLessonQuiz'; conceptId: string; body: { activityId: string } }
  | { kind: 'answerLessonQuiz'; conceptId: string; body: Record<string, unknown> }
  | { kind: 'submitLessonQuiz'; conceptId: string; body: { activityId: string } }
  | { kind: 'exerciseAttempt'; body: Record<string, unknown> }
  | { kind: 'startPlacement'; body: Record<string, unknown> }
  | { kind: 'placementNext'; placementId: string }
  | { kind: 'placementAnswer'; placementId: string; body: Record<string, unknown> }
  | { kind: 'placementResults'; placementId: string }
  | { kind: 'startTimedQuiz'; body: { sessionId: string; activityId: string } }
  | { kind: 'timedQuiz'; quizId: string }
  | { kind: 'answerTimedQuiz'; quizId: string; body: Record<string, unknown> }
  | { kind: 'finalizeTimedQuiz'; quizId: string }
  | { kind: 'retakeTimedQuiz'; quizId: string }
  | { kind: 'timedQuizFollowUps'; quizId: string };

export type EngineGrade = (
  exercise: Parameters<typeof gradeExercise>[0],
  answer: unknown,
  options: { random: () => number },
) => ReturnType<typeof gradeExercise>;

export type EngineRequest = {
  store: CourseStore;
  userId: string;
  timeZone: string;
  now: () => Date;
  content: ContentIndex;
  random: () => number;
  newId: () => string;
  grade: EngineGrade;
  fsrsFuzz: boolean;
  tutorEnabled: boolean;
  repo: EngineLearnerRepository;
  freshRepo: (store: CourseStore, withSessionContent: boolean) => EngineLearnerRepository;
};

export type EngineInput<K extends EngineOperation['kind']> =
  Omit<Extract<EngineOperation, { kind: K }>, 'kind'> extends infer Input
    ? keyof Input extends never
      ? undefined
      : Input
    : never;

export type EngineLearner = {
  [K in EngineOperation['kind']]: [EngineInput<K>] extends [undefined]
    ? () => Promise<EngineResult>
    : (input: EngineInput<K>) => Promise<EngineResult>;
};

export const respond = (body: unknown, status: EngineResult['status'] = 200): EngineResult => ({
  status,
  body,
});
