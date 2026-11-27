import type { ContentIndex } from '../course/types.js';
import type { gradeExercise } from '../lessons/grading/index.js';
import type { GradeResult } from '../lessons/grading/types.js';
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
  | { kind: 'course'; courseId?: string; course?: string }
  | { kind: 'setActiveCourse'; body: unknown }
  | { kind: 'startCourse'; courseId?: string; body: unknown }
  | { kind: 'createSession'; body: unknown }
  | { kind: 'session'; sessionId: string }
  | { kind: 'replanSession'; sessionId: string; body?: Record<string, unknown> }
  | { kind: 'endSession'; sessionId: string }
  | {
      kind: 'activityProgress';
      sessionId: string;
      activityId: string;
      body: unknown;
    }
  | { kind: 'startLessonRun'; conceptId: string; body: unknown }
  | { kind: 'practiceLessonPoint'; conceptId: string; body: unknown }
  | { kind: 'answerLessonProblem'; conceptId: string; body: unknown }
  | { kind: 'startLessonQuiz'; conceptId: string; body: unknown }
  | { kind: 'answerLessonQuiz'; conceptId: string; body: unknown }
  | { kind: 'submitLessonQuiz'; conceptId: string; body: unknown }
  | { kind: 'exerciseAttempt'; body: unknown }
  | { kind: 'startPlacement'; body: unknown }
  | { kind: 'placementNext'; placementId: string }
  | { kind: 'placementAnswer'; placementId: string; body: unknown }
  | { kind: 'placementResults'; placementId: string }
  | { kind: 'startTimedQuiz'; body: unknown }
  | { kind: 'timedQuiz'; quizId: string }
  | { kind: 'answerTimedQuiz'; quizId: string; body: unknown }
  | { kind: 'finalizeTimedQuiz'; quizId: string }
  | { kind: 'retakeTimedQuiz'; quizId: string }
  | { kind: 'timedQuizFollowUps'; quizId: string };

export type EngineGradeResult =
  | GradeResult
  | {
      status: 'graded';
      correct: number;
      feedback: string;
      graded_by: 'llm';
      mistake_category?: string;
      rubric: Array<{
        id: string;
        criterion: string;
        judgement: 'met' | 'partial' | 'missing';
        required: boolean;
      }>;
      exemplar: string;
    };

export type EngineGrade = (
  exercise: Parameters<typeof gradeExercise>[0],
  answer: unknown,
  options: { random: () => number },
) => EngineGradeResult | Promise<EngineGradeResult>;

export type EngineHasTutorReply = (
  store: CourseStore,
  learnerId: string,
  problemId: string,
) => Promise<boolean>;

export type EngineRequest = {
  store: CourseStore;
  userId: string;
  timeZone: string;
  now: () => Date;
  content: ContentIndex;
  random: () => number;
  newId: () => string;
  grade: EngineGrade;
  hasTutorReply: EngineHasTutorReply;
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
