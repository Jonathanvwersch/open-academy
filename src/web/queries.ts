import { queryOptions } from '@tanstack/react-query';
import type { ClientExercise, LessonBlockKind } from './components.js';

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

export interface SessionActivity {
  id: string;
  idx: number;
  kind: string;
  conceptId?: string;
  conceptTitle?: string;
  projectId?: string;
  exerciseIds: string[];
  plannedMinutes: number;
  status: string;
  startedAt?: string;
  progress: {
    lessonViewed?: boolean;
    lessonRunnerContinued?: boolean;
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
}

export interface LessonPayload {
  blocks: Array<{ kind: LessonBlockKind; md?: string; exercise?: string }>;
  knowledge_points?: Array<{
    id: string;
    title: string;
    explain: string;
    worked: string;
    problems: string[];
  }>;
}

export type ExercisePayload = ClientExercise;

export interface LessonRunPayload {
  run: null | {
    id: string;
    status: 'in_progress' | 'needs_retry' | 'completed';
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
      correct: number | null;
      round: number;
      position: number;
      activityId?: string | null;
      exercise: ClientExercise;
      result: { correct: number | null; feedback: string; solution: string };
    };
    xpEarned: number;
  };
}

export interface ProgressPayload {
  domains: Array<{ id: string; title: string; counts: Record<string, number> }>;
  goal: { mastered: number; total: number };
  debt: Array<{
    conceptId: string;
    title: string;
    dimension: string;
    reason: string;
    remediationAction: string;
    studyUrl: string;
  }>;
  evidence: Array<{
    id: string;
    exerciseId: string;
    conceptId: string;
    conceptTitle: string;
    correct: number;
    createdAt: string;
    event: string | null;
  }>;
  hours: number;
  planHours: number;
  streakDays: number;
}

export interface MapPayload {
  nodes: Array<{
    id: string;
    title: string;
    domain: string;
    status: string;
    available: boolean;
    dimensions: Record<string, { state: string; inferred?: boolean }>;
  }>;
  edges: Array<{ conceptId: string; prerequisiteId: string }>;
  domains: Array<{ id: string; title: string }>;
  currentWeekDomain: string;
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

async function getJson<T>(url: string, message: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(message);
  return (await response.json()) as T;
}

export const todayQueryOptions = () =>
  queryOptions({
    queryKey: ['today'] as const,
    queryFn: () => getJson<TodayPayload>('/api/today', 'Could not load Today'),
  });

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

export const mapQueryOptions = (domain: string | null) =>
  queryOptions({
    queryKey: ['map', domain] as const,
    queryFn: () =>
      getJson<MapPayload>(
        `/api/map${domain === null ? '' : `?domain=${encodeURIComponent(domain || 'all')}`}`,
        'Map unavailable',
      ),
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
    queryFn: () => getJson<ProjectPayload>(`/api/projects/${projectId}`, 'Project unavailable'),
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
