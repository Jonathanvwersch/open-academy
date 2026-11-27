import type { AnswerOptions, RubricFeedbackItem } from '@open-academy/engine/api/exercises';

export interface TodayPayload {
  tutorEnabled: boolean;
  needsCourseChoice: boolean;
  courseStart: { courseId: string | null; needed: boolean; placementRunId: string | null };
  studyCourses: Array<{
    id: string;
    title: string;
    subjectId?: string;
    topicsDone: number;
    topicsTotal: number;
    unitTitle: string;
  }>;
  objective: string;
  courseTitle: string;
  unitTitle: string;
  unit: number;
  dueReviews: number;
  budgetMinutes: number;
  quizOffer?: { xpBalance: number; plannedMinutes: number | null; active: boolean };
  sessionKind: 'weekday' | 'saturday' | 'sunday';
  activeSessionId: string | null;
  plan: {
    activities: Array<{
      kind: string;
      conceptId?: string | null;
      conceptTitle?: string | null;
      reviewTopics?: Array<{ conceptId: string; title: string }>;
      allReviewTopics?: Array<{ conceptId: string; title: string }>;
      plannedMinutes: number;
      reason: { summary: string };
    }>;
  };
}

export interface SessionActivity {
  id: string;
  idx: number;
  kind: string;
  conceptId?: string | null;
  conceptTitle?: string | null;
  reviewTopics?: Array<{ conceptId: string; title: string }>;
  allReviewTopics?: Array<{ conceptId: string; title: string }>;
  projectId?: string | null;
  exerciseIds: string[];
  exerciseId?: string;
  plannedMinutes: number;
  status: string;
  lessonAvailable?: boolean;
  lessonRunner?: boolean;
  lessonQuiz?: boolean;
  lastAttempt?: {
    exerciseId?: string;
    status?: string;
    correct?: number;
    outcome?: 'correct' | 'incorrect';
    attemptNo?: number;
    followUp?: boolean;
    retryAllowed?: boolean;
    feedback?: string;
    rubric?: RubricFeedbackItem[];
    exemplar?: string;
    solution?: string;
    yourAnswer?: string;
    answerOptions?: AnswerOptions;
  } | null;
  startedAt?: string | null;
  progress: {
    lessonViewed?: boolean;
    lessonRunnerContinued?: boolean;
    finalQuestionContinued?: boolean;
    quizContinued?: boolean;
    completedExerciseIds?: string[];
    outcomes?: Record<string, 'correct' | 'incorrect'>;
  };
}

export interface ActiveSessionPayload {
  id: string;
  activities: Array<Pick<SessionActivity, 'kind' | 'conceptId' | 'status'>>;
}

export interface SessionPayload {
  activities: SessionActivity[];
  current: {
    activityId?: string;
    completedFinalId?: string;
    openableIds: string[];
  };
  quizFollowUp?: string;
  plannedMinutes: number;
  startedAt?: string;
  serverNow?: string;
  tutorEnabled: boolean;
  xp: { session: number; today: number; goal: number };
}
