import type { AnswerOptions } from '@academy/contracts/exercises';

export interface TodayPayload {
  tutorEnabled: boolean;
  needsDiagnostic: boolean;
  diagnosticActive: boolean;
  diagnosticRunId: string | null;
  objective: string;
  courseTitle: string;
  unitTitle: string;
  unit: number;
  dueReviews: number;
  budgetMinutes: number;
  sessionKind: 'weekday' | 'saturday' | 'sunday';
  activeSessionId: string | null;
  plan: {
    activities: Array<{
      kind: string;
      conceptId?: string;
      conceptTitle?: string;
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
  projectId?: string;
  exerciseIds: string[];
  plannedMinutes: number;
  status: string;
  lessonAvailable?: boolean;
  lastAttempt?: {
    exerciseId?: string;
    status?: string;
    correct?: number;
    attemptNo?: number;
    retryAllowed?: boolean;
    feedback?: string;
    yourAnswer?: string;
    answerOptions?: AnswerOptions;
  } | null;
  startedAt?: string;
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
  plannedMinutes: number;
  startedAt?: string;
  serverNow?: string;
  tutorEnabled: boolean;
  xp: { session: number; today: number; goal: number };
}
