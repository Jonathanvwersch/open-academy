export { ContentValidationError, parseCourses } from './course/load.js';
export type { Dimension, Exercise } from './course/schemas.js';
export { ExerciseSchema } from './course/schemas.js';
export { instantiateExercise, isTemplate } from './course/templates.js';
export type {
  ContentEdge,
  ContentIndex,
  ContentIssue,
  ContentSourceData,
  IndexedConcept,
  IndexedCourse,
  IndexedExercise,
  IndexedLesson,
  IndexedPaper,
  IndexedProject,
} from './course/types.js';
export type {
  CreateEngineOptions,
  EngineGenerateHint,
  EngineGrade,
  EngineGradeResult,
  EngineHasTutorReply,
  EngineHintContext,
  EngineJudgeExplanation,
  EngineLearner,
  EngineLearnerOptions,
  EngineOperation,
  EngineResult,
  EngineTutorPaper,
} from './engine/create-engine.js';
export { createEngine } from './engine/create-engine.js';
export type { EngineUser } from './engine/repository.js';
export { EngineLearnerRepository } from './engine/repository.js';
export { gradeExercise } from './lessons/grading/index.js';
export { startOfNextCalendarDay } from './memory/fsrs.js';
export { TOPIC_SPEED_DECAY, TOPIC_SPEED_POLICY } from './memory/speed.js';
export type { MasteryRecord, MasteryState } from './memory/types.js';
export { initialMastery } from './memory/types.js';
export { localDateKey } from './progress/xp.js';
export type { QuizQuestion } from './quizzes/mixed-quiz.js';
export type {
  Attempt,
  AttemptQuery,
  CoreStore,
  DayKey,
  Enrollment,
  EnrollmentWrite,
  HintEventInput,
  HintEventReceipt,
  Id,
  LockStrength,
  NewRow,
  Settings,
  XpEvent,
  XpQuery,
} from './store/core-store.js';
export type {
  CourseMasteryEvent,
  CoursePaperProgress,
  CourseProjectProgress,
  CourseProjectSubmission,
  CourseStore,
  PaperProgressPatch,
  PaperProgressRecord,
} from './store/course-store.js';
export { compareCompletedActivities } from './store/course-store.js';
export type {
  FlowStore,
  TimedQuizItem,
  TimedQuizItemKey,
  TimedQuizQuery,
  TimedQuizRun,
} from './store/flow-store.js';
export { collectTimedQuizItemKeys } from './store/flow-store.js';
export type {
  LearnerStore,
  MasteryEventQuery,
  MasteryEventRecord,
  NewReviewCard,
  OpenRemediationFlag,
  ReviewLogRecord,
  StoredMasteryEvent,
  StoredReviewCard,
} from './store/learner-store.js';
export type {
  FlagQuery,
  LessonKey,
  LessonProblem,
  LessonQuiz,
  LessonQuizAttempt,
  LessonQuizEvidence,
  LessonQuizItem,
  LessonRun,
  LessonStore,
  ReviewLogEntry,
} from './store/lesson-store.js';
export type { MemoryLearnerStore } from './store/memory-store.js';
export { memoryStore } from './store/memory-store.js';
export type {
  DiagnosticRun,
  PlacementGrant,
  PlacementReviewStore,
} from './store/placement-review-store.js';
export type {
  Activity,
  ActivityExpected,
  ActivityQuery,
  RemediationFlag,
  RowEdit,
  SchedulerFacts,
  SchedulerRead,
  Session,
  SessionQuery,
  SessionStore,
} from './store/session-store.js';
