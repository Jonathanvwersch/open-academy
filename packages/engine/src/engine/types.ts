import type { TutorContextInput, TutorPrompt } from '../api/tutor.js';
import type { ContentIndex, IndexedPaper } from '../course/types.js';
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
  | { kind: 'progress' }
  | { kind: 'reviews' }
  | { kind: 'studyMap' }
  | { kind: 'concept'; conceptId: string }
  | { kind: 'planWeek' }
  | { kind: 'lesson'; conceptId: string }
  | { kind: 'lessonReview'; conceptId: string }
  | { kind: 'exercise'; id: string }
  | { kind: 'hint'; body: unknown }
  | ({ kind: 'tutorContext' } & TutorContextInput)
  | { kind: 'activeSession' }
  | { kind: 'lessonRun'; conceptId: string; activityId?: string }
  | { kind: 'lessonQuizReview'; conceptId: string; attemptId: string }
  | { kind: 'learn' }
  | { kind: 'courseCatalog' }
  | { kind: 'settings' }
  | { kind: 'saveSettings'; body: unknown }
  | { kind: 'course'; courseId?: string; course?: string }
  | { kind: 'setActiveCourse'; body: unknown }
  | { kind: 'setFocus'; body: unknown }
  | { kind: 'restartTopic'; conceptId: string }
  | { kind: 'setEnrollment'; courseId: string; body: unknown }
  | { kind: 'startCourse'; courseId?: string; body: unknown }
  | { kind: 'createSession'; body: unknown }
  | { kind: 'session'; sessionId: string }
  | { kind: 'replanSession'; sessionId: string; body?: Record<string, unknown> }
  | { kind: 'endSession'; sessionId: string }
  | { kind: 'continueActivity'; sessionId: string; activityId: string; body: unknown }
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
  | { kind: 'timedQuizFollowUps'; quizId: string }
  | { kind: 'projects' }
  | { kind: 'project'; id: string }
  | { kind: 'submitProjectResults'; id: string; body: unknown }
  | { kind: 'papers' }
  | { kind: 'paper'; id: string }
  | { kind: 'savePaperProgress'; id: string; body: unknown }
  | { kind: 'submitPaperSummary'; id: string; body: unknown };

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

export type EngineHintContext = {
  prompt: TutorPrompt;
  level: 'nudge' | 'hint' | 'worked_step';
};

export type EngineGenerateHint = (
  input: EngineHintContext,
) => Promise<{ kind: 'ok'; text: string } | { kind: 'disabled' | 'unavailable' }>;

export type EngineTutorPaper = (
  paperId: string,
  pageNumber: number,
) => Promise<
  | {
      notes: Record<string, string>;
      summary?: string | null;
      feedback?: unknown;
      pages: Array<{ page: number; text: string }>;
    }
  | undefined
>;

export type EngineJudgeExplanation = (input: {
  question: string;
  rubric: IndexedPaper['summary']['rubric'];
  exemplar: IndexedPaper['summary']['exemplar'];
  answer: string;
}) => Promise<
  | {
      judgement: {
        criteria: Array<{
          id: string;
          judgement: 'met' | 'partial' | 'missing';
          evidence?: string | null;
        }>;
        feedback_md: string;
      };
    }
  | { reason: string }
>;

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
  generateHint?: EngineGenerateHint;
  tutorPaper?: EngineTutorPaper;
  judgeExplanation?: EngineJudgeExplanation;
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
