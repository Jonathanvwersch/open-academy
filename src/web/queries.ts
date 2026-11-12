import { queryOptions } from '@tanstack/react-query';
import type { LessonPrerequisite } from '../server/content/schemas.js';
import { apiFetch } from './authenticated-fetch.js';
import type { AnswerOptions, ClientExercise, LessonBlockKind } from './components.js';

export interface TodayPayload {
  needsDiagnostic: boolean;
  diagnosticActive: boolean;
  diagnosticRunId: string | null;
  objective: string;
  weekTitle: string;
  week: number;
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

export interface LearnPayload {
  xp: {
    total: number;
    today: number;
    goal: number;
    week: Array<{ date: string; xp: number; goal: number }>;
  };
  course: {
    percentComplete: number;
    topicsDone: number;
    topicsTotal: number;
    estimatedFinish: string | null;
    estimatedFinishAtGoal: string | null;
  };
  tasks: Array<{
    activityKind: string;
    label: 'Lesson' | 'Review' | 'Practice' | 'Project' | 'Quiz';
    conceptId?: string;
    title: string;
    xp: number;
    prerequisites: Array<{ id: string; title: string; done: boolean }>;
  }>;
  choices: Array<{
    conceptId: string;
    title: string;
    xp: number;
    recommended: boolean;
  }>;
  doneToday: Array<{ label: string; title: string; xp: number; completedAt: string }>;
  activeSessionId: string | null;
}

export interface CoursePayload {
  weeks: Array<{
    week: number;
    title: string;
    intro: string;
    project: {
      id: string;
      title: string;
      available: boolean;
      status: 'not_started' | 'in_progress' | 'completed';
    } | null;
    papers: Array<{
      id: string;
      title: string;
      authors: string;
      year: number;
      estMinutes: number;
      status: 'not_started' | 'reading' | 'completed';
    }>;
    topics: Array<{
      number: string;
      conceptId: string;
      title: string;
      hasLesson: boolean;
      status: 'locked' | 'not_started' | 'in_progress' | 'quiz' | 'complete';
      mastery: 'Not started' | 'Attempted' | 'Familiar' | 'Proficient' | 'Mastered';
      needs?: Array<{ id: string; title: string; quiz?: boolean }>;
      buildsOn: Array<{ id: string; title: string }>;
      leadsTo: Array<{ id: string; title: string }>;
      leadsToMore: number;
    }>;
  }>;
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

export interface SessionPayload {
  activities: SessionActivity[];
  plannedMinutes: number;
  startedAt?: string;
  serverNow?: string;
  tutorEnabled: boolean;
  xp: { session: number; today: number; goal: number };
}

export interface LessonPayload {
  where_this_fits?: string;
  prerequisites?: LessonPrerequisite[];
  final?: string;
  blocks: Array<{ kind: LessonBlockKind; md?: string; exercise?: string }>;
  knowledge_points?: Array<{
    id: string;
    title: string;
    explain: string;
    worked: string;
    problems: string[];
  }>;
}

export interface LessonReviewPayload {
  lesson: LessonPayload;
  checkAnswers: Record<string, string>;
  conceptTitle: string;
}

export type ExercisePayload = ClientExercise;

export interface LessonRunPayload {
  run: null | {
    id: string;
    status: 'in_progress' | 'needs_retry' | 'quiz' | 'completed';
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
    currentPoint?: { id: string; title: string; explain: string; worked: string };
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
      current?: {
        attemptId: string;
        items: Array<{
          id: string;
          position: number;
          exercise: ClientExercise | null;
          answered: boolean;
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

export interface ProgressPayload {
  domains: Array<{ id: string; title: string; counts: Record<string, number> }>;
  goal: { mastered: number; total: number };
  hours: number;
  planHours: number;
  streakDays: number;
}

export interface ProjectPayload {
  project: {
    title: string;
    objective: string;
    background: string;
    tasks: Array<{ id: string; title: string; md: string }>;
    acceptance: string[];
  };
}

export interface SettingsPayload {
  scheduleMinutes: number;
  saturdayMinutes: number;
  sundayMinutes: number;
  startDate: string;
}

export interface DiagnosticResultsPayload {
  domains: Array<{
    id: string;
    title: string;
    outcome: string;
    answers: number;
    knownConcepts: string[];
    gaps: string[];
  }>;
  plan: {
    firstWeek: { title: string } | null;
    firstWeekConcepts: string[];
    firstSession: Array<{
      kind: string;
      conceptTitle?: string;
      plannedMinutes: number;
      reason: { summary: string };
    }>;
    ninetyDayPath: Array<{ week: number; title: string }>;
  };
}

export interface TutorThreadSummary {
  id: string;
  conceptId: string | null;
  conceptTitle: string | null;
  title: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview: string;
}

export interface TutorThreadDetail {
  thread: TutorThreadSummary;
  messages: Array<{ id: string; role: string; content: string; createdAt: string }>;
}

export interface AuthPayload {
  authenticated: boolean;
  authRequired: boolean;
}

export const authQueryOptions = () =>
  queryOptions({
    queryKey: ['auth', 'me'] as const,
    queryFn: () => getJson<AuthPayload>('/api/auth/me', 'Could not check authentication'),
    staleTime: Infinity,
  });

async function getJson<T>(url: string, message: string): Promise<T> {
  const response = await apiFetch(url);
  if (!response.ok) throw new Error(message);
  return (await response.json()) as T;
}

export const todayQueryOptions = () =>
  queryOptions({
    queryKey: ['today'] as const,
    queryFn: () => getJson<TodayPayload>('/api/today', 'Could not load Today'),
  });

export const learnQueryOptions = () =>
  queryOptions({
    queryKey: ['learn'] as const,
    queryFn: () => getJson<LearnPayload>('/api/learn', 'Could not load Learn'),
  });

export const courseQueryOptions = () =>
  queryOptions({
    queryKey: ['course'] as const,
    queryFn: () => getJson<CoursePayload>('/api/course', 'Could not load Course'),
  });

export interface PapersPayload {
  weeks: Array<{
    week: number;
    papers: Array<{
      id: string;
      title: string;
      authors: string;
      year: number;
      est_minutes: number;
      status: 'not_started' | 'reading' | 'completed';
    }>;
  }>;
}

export const papersQueryOptions = () =>
  queryOptions({
    queryKey: ['papers'] as const,
    queryFn: () => getJson<PapersPayload>('/api/papers', 'Could not load papers'),
  });

export const paperQueryOptions = (paperId: string) =>
  queryOptions({
    queryKey: ['paper', paperId] as const,
    queryFn: () =>
      getJson<{
        paper: {
          id: string;
          title: string;
          authors: string;
          year: number;
          week: number;
          est_minutes: number;
          source: { arxiv: string } | { url: string };
          questions: Array<{ id: string; kind: string; prompt: string }>;
          why_this_week: string;
          how_to_read: string;
          summary: {
            prompt: string;
            rubric?: Array<{ id: string; criterion: string; weight: number; required: boolean }>;
          };
        };
        progress: {
          lastPage: number;
          notes: Record<string, string>;
          summary: string | null;
          summaryJudgement: unknown;
        } | null;
        originalUrl: string;
      }>(`/api/papers/${encodeURIComponent(paperId)}`, 'Paper not found'),
  });

export function paperStatusLabel(
  status: PapersPayload['weeks'][number]['papers'][number]['status'],
) {
  return status === 'not_started' ? 'Not started' : status === 'reading' ? 'Reading' : 'Completed';
}

export const sessionQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['session', id] as const,
    queryFn: () =>
      getJson<SessionPayload>(`/api/sessions/${encodeURIComponent(id)}`, 'Session not found'),
  });

export const lessonQueryOptions = (conceptId: string | null) =>
  queryOptions({
    queryKey: ['lesson', conceptId] as const,
    queryFn: () =>
      conceptId
        ? getJson<LessonPayload>(
            `/api/lessons/${encodeURIComponent(conceptId)}`,
            'Lesson not found',
          )
        : Promise.resolve(null),
  });

export const lessonReviewQueryOptions = (conceptId: string) =>
  queryOptions({
    queryKey: ['lesson-review', conceptId] as const,
    queryFn: () =>
      getJson<LessonReviewPayload>(
        `/api/lessons/${encodeURIComponent(conceptId)}/review`,
        'Lesson not found',
      ),
  });

export const lessonRunQueryOptions = (conceptId: string | null) =>
  queryOptions({
    queryKey: ['lesson-run', conceptId] as const,
    queryFn: () =>
      conceptId
        ? getJson<LessonRunPayload>(
            `/api/lessons/${encodeURIComponent(conceptId)}/run`,
            'Lesson progress unavailable',
          )
        : Promise.resolve({ run: null }),
  });

export const exerciseQueryOptions = (exerciseId: string | null) =>
  queryOptions({
    queryKey: ['exercise', exerciseId] as const,
    queryFn: () =>
      exerciseId
        ? getJson<ExercisePayload>(
            `/api/exercises/${encodeURIComponent(exerciseId)}`,
            'Exercise not found',
          )
        : Promise.resolve(null),
  });

export const progressQueryOptions = () =>
  queryOptions({
    queryKey: ['progress'] as const,
    queryFn: () => getJson<ProgressPayload>('/api/progress', 'Progress unavailable'),
  });

export const conceptQueryOptions = (conceptId: string) =>
  queryOptions({
    queryKey: ['concept', conceptId] as const,
    queryFn: () =>
      getJson<Record<string, unknown>>(
        `/api/concepts/${encodeURIComponent(conceptId)}`,
        'Concept unavailable',
      ),
  });

export const projectQueryOptions = (projectId: string) =>
  queryOptions({
    queryKey: ['project', projectId] as const,
    queryFn: () =>
      getJson<ProjectPayload>(
        `/api/projects/${encodeURIComponent(projectId)}`,
        'Project unavailable',
      ),
  });

export const settingsQueryOptions = () =>
  queryOptions({
    queryKey: ['settings'] as const,
    queryFn: () => getJson<SettingsPayload>('/api/settings', 'Could not load settings'),
  });

export const latestDiagnosticQueryOptions = () =>
  queryOptions({
    queryKey: ['diagnostic', 'latest'] as const,
    queryFn: () => getJson<{ id: string }>('/api/diagnostic/latest', 'No completed diagnostic'),
  });

export const diagnosticResultsQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['diagnostic', 'results', id] as const,
    queryFn: () =>
      getJson<DiagnosticResultsPayload>(
        `/api/diagnostic/${encodeURIComponent(id)}/results`,
        'Could not load diagnostic results',
      ),
  });

export const tutorThreadsQueryOptions = () =>
  queryOptions({
    queryKey: ['tutor', 'threads'] as const,
    queryFn: () =>
      getJson<TutorThreadSummary[]>('/api/tutor/threads', 'Tutor conversations unavailable'),
  });

export const tutorThreadQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['tutor', 'thread', id] as const,
    queryFn: () =>
      getJson<TutorThreadDetail>(
        `/api/tutor/threads/${encodeURIComponent(id)}`,
        'Tutor conversation unavailable',
      ),
  });
