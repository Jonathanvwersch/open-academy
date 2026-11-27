import type { ContentIndex } from '../course/types.js';
import { gradeExercise } from '../lessons/grading/index.js';
import type { Settings } from '../store/core-store.js';
import type { CourseStore } from '../store/course-store.js';
import { runEngineOperation } from './operations.js';
import { EngineLearnerRepository, engineUser } from './repository.js';
import type {
  EngineGenerateHint,
  EngineGrade,
  EngineHasTutorReply,
  EngineJudgeSummary,
  EngineLearner,
  EngineOperation,
  EngineResult,
  EngineTutorPaper,
} from './types.js';

export type {
  EngineGenerateHint,
  EngineGrade,
  EngineGradeResult,
  EngineHasTutorReply,
  EngineHintContext,
  EngineJudgeSummary,
  EngineLearner,
  EngineOperation,
  EngineResult,
  EngineTutorPaper,
} from './types.js';

export type CreateEngineOptions = {
  content: () => Promise<ContentIndex>;
  store: CourseStore;
  grade?: EngineGrade;
  newId?: () => string;
  fsrsFuzz?: boolean;
  tutorEnabled?: boolean;
};

export type EngineLearnerOptions = {
  id: string;
  timeZone: string;
  now: () => Date;
  random: () => number;
  grade?: EngineGrade;
  hasTutorReply?: EngineHasTutorReply;
  generateHint?: EngineGenerateHint;
  tutorPaper?: EngineTutorPaper;
  judgeSummary?: EngineJudgeSummary;
  settings?: Settings;
};

export function createEngine(options: CreateEngineOptions) {
  const newId = options.newId ?? (() => crypto.randomUUID());
  const grade: EngineGrade =
    options.grade ??
    ((exercise, answer, { random }) => gradeExercise(exercise, answer, { random }));
  const fsrsFuzz = options.fsrsFuzz ?? true;
  const tutorEnabled = options.tutorEnabled ?? false;

  return {
    learner({
      id,
      timeZone,
      now,
      random,
      grade: learnerGrade,
      hasTutorReply = async () => false,
      generateHint,
      tutorPaper,
      judgeSummary,
      settings,
    }: EngineLearnerOptions): EngineLearner {
      const contentPromise = options.content();
      const requestPromise = Promise.all([
        contentPromise,
        settings ? Promise.resolve(settings) : options.store.getSettings(id),
      ]).then(([content, settings]) => ({
        store: options.store,
        userId: id,
        timeZone,
        now,
        content,
        random,
        newId,
        grade: learnerGrade ?? grade,
        hasTutorReply,
        ...(generateHint ? { generateHint } : {}),
        ...(tutorPaper ? { tutorPaper } : {}),
        ...(judgeSummary ? { judgeSummary } : {}),
        fsrsFuzz,
        tutorEnabled,
        repo: new EngineLearnerRepository(
          options.store,
          id,
          engineUser(id, settings),
          { load: () => contentPromise, now },
          fsrsFuzz,
        ),
        freshRepo: (store: CourseStore, withSessionContent: boolean) =>
          new EngineLearnerRepository(
            store,
            id,
            undefined,
            withSessionContent ? { load: () => contentPromise, now } : undefined,
            fsrsFuzz,
          ),
      }));
      const call = (operation: EngineOperation): Promise<EngineResult> =>
        requestPromise.then((request) => runEngineOperation(request, operation));

      const learner: EngineLearner = {
        today: () => call({ kind: 'today' }),
        learn: () => call({ kind: 'learn' }),
        courseCatalog: () => call({ kind: 'courseCatalog' }),
        course: (input) => call({ kind: 'course', ...input }),
        setActiveCourse: (input) => call({ kind: 'setActiveCourse', ...input }),
        startCourse: (input) => call({ kind: 'startCourse', ...input }),
        createSession: (input) => call({ kind: 'createSession', ...input }),
        session: (input) => call({ kind: 'session', ...input }),
        replanSession: (input) => call({ kind: 'replanSession', ...input }),
        endSession: (input) => call({ kind: 'endSession', ...input }),
        activityProgress: (input) => call({ kind: 'activityProgress', ...input }),
        startLessonRun: (input) => call({ kind: 'startLessonRun', ...input }),
        practiceLessonPoint: (input) => call({ kind: 'practiceLessonPoint', ...input }),
        answerLessonProblem: (input) => call({ kind: 'answerLessonProblem', ...input }),
        startLessonQuiz: (input) => call({ kind: 'startLessonQuiz', ...input }),
        answerLessonQuiz: (input) => call({ kind: 'answerLessonQuiz', ...input }),
        submitLessonQuiz: (input) => call({ kind: 'submitLessonQuiz', ...input }),
        exerciseAttempt: (input) => call({ kind: 'exerciseAttempt', ...input }),
        progress: () => call({ kind: 'progress' }),
        reviews: () => call({ kind: 'reviews' }),
        studyMap: () => call({ kind: 'studyMap' }),
        concept: (input) => call({ kind: 'concept', ...input }),
        planWeek: () => call({ kind: 'planWeek' }),
        lesson: (input) => call({ kind: 'lesson', ...input }),
        lessonReview: (input) => call({ kind: 'lessonReview', ...input }),
        exercise: (input) => call({ kind: 'exercise', ...input }),
        hint: (input) => call({ kind: 'hint', ...input }),
        tutorContext: (input) => call({ kind: 'tutorContext', ...input }),
        activeSession: () => call({ kind: 'activeSession' }),
        lessonRun: (input) => call({ kind: 'lessonRun', ...input }),
        lessonQuizReview: (input) => call({ kind: 'lessonQuizReview', ...input }),
        startPlacement: (input) => call({ kind: 'startPlacement', ...input }),
        placementNext: (input) => call({ kind: 'placementNext', ...input }),
        placementAnswer: (input) => call({ kind: 'placementAnswer', ...input }),
        placementResults: (input) => call({ kind: 'placementResults', ...input }),
        startTimedQuiz: (input) => call({ kind: 'startTimedQuiz', ...input }),
        timedQuiz: (input) => call({ kind: 'timedQuiz', ...input }),
        answerTimedQuiz: (input) => call({ kind: 'answerTimedQuiz', ...input }),
        finalizeTimedQuiz: (input) => call({ kind: 'finalizeTimedQuiz', ...input }),
        retakeTimedQuiz: (input) => call({ kind: 'retakeTimedQuiz', ...input }),
        timedQuizFollowUps: (input) => call({ kind: 'timedQuizFollowUps', ...input }),
        projects: () => call({ kind: 'projects' }),
        project: (input) => call({ kind: 'project', ...input }),
        submitProjectResults: (input) => call({ kind: 'submitProjectResults', ...input }),
        papers: () => call({ kind: 'papers' }),
        paper: (input) => call({ kind: 'paper', ...input }),
        savePaperProgress: (input) => call({ kind: 'savePaperProgress', ...input }),
        submitPaperSummary: (input) => call({ kind: 'submitPaperSummary', ...input }),
      };
      return learner;
    },
  };
}
