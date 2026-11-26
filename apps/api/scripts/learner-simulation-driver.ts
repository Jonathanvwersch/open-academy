import type { ContentIndex } from '@academy/aesop/course/types';
import type { ImplicitRepetitionTraceEvent } from '@academy/aesop/memory/mastery-service';
import type { SimulatorAudit, SimulatorFixtures } from './learner-simulation-audit.js';

/** One logical learner action. Each driver runs it; `httpRequestFor` gives its HTTP form. */
export type SimulatorOperation =
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
  | { kind: 'timedQuizFollowUps'; quizId: string }
  | { kind: 'paperProgress'; paperId: string; body: Record<string, unknown> };

export type SimulatorOperationKind = SimulatorOperation['kind'];

export interface SimulatorHttpRequest {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  body?: unknown;
}

/** The API request each operation stands for. Both drivers derive request keys from it. */
export function httpRequestFor(operation: SimulatorOperation): SimulatorHttpRequest {
  switch (operation.kind) {
    case 'today':
      return { method: 'GET', path: '/today' };
    case 'learn':
      return { method: 'GET', path: '/learn' };
    case 'courseCatalog':
      return { method: 'GET', path: '/courses' };
    case 'course':
      return { method: 'GET', path: `/courses/${encodeURIComponent(operation.courseId)}` };
    case 'setActiveCourse':
      return { method: 'PUT', path: '/course/active', body: operation.body };
    case 'startCourse':
      return { method: 'POST', path: `/courses/${operation.courseId}/start`, body: operation.body };
    case 'createSession':
      return { method: 'POST', path: '/sessions', body: operation.body };
    case 'session':
      return { method: 'GET', path: `/sessions/${operation.sessionId}` };
    case 'replanSession':
      return { method: 'POST', path: `/sessions/${operation.sessionId}/replan` };
    case 'endSession':
      return { method: 'POST', path: `/sessions/${operation.sessionId}/end` };
    case 'activityProgress':
      return {
        method: 'POST',
        path: `/sessions/${operation.sessionId}/activities/${operation.activityId}/progress`,
        body: operation.body,
      };
    case 'startLessonRun':
      return { method: 'POST', path: `/lessons/${operation.conceptId}/run`, body: operation.body };
    case 'practiceLessonPoint':
      return {
        method: 'POST',
        path: `/lessons/${operation.conceptId}/run/practice`,
        body: operation.body,
      };
    case 'answerLessonProblem':
      return {
        method: 'POST',
        path: `/lessons/${operation.conceptId}/run/answer`,
        body: operation.body,
      };
    case 'startLessonQuiz':
      return {
        method: 'POST',
        path: `/lessons/${operation.conceptId}/quiz/start`,
        body: operation.body,
      };
    case 'answerLessonQuiz':
      return {
        method: 'POST',
        path: `/lessons/${operation.conceptId}/quiz/answer`,
        body: operation.body,
      };
    case 'submitLessonQuiz':
      return {
        method: 'POST',
        path: `/lessons/${operation.conceptId}/quiz/submit`,
        body: operation.body,
      };
    case 'exerciseAttempt':
      return { method: 'POST', path: '/attempts', body: operation.body };
    case 'startPlacement':
      return { method: 'POST', path: '/placement', body: operation.body };
    case 'placementNext':
      return { method: 'GET', path: `/placement/${operation.placementId}/next` };
    case 'placementAnswer':
      return {
        method: 'POST',
        path: `/placement/${operation.placementId}/answer`,
        body: operation.body,
      };
    case 'placementResults':
      return { method: 'GET', path: `/placement/${operation.placementId}/results` };
    case 'startTimedQuiz':
      return { method: 'POST', path: '/quizzes/start', body: operation.body };
    case 'timedQuiz':
      return { method: 'GET', path: `/quizzes/${operation.quizId}` };
    case 'answerTimedQuiz':
      return { method: 'POST', path: `/quizzes/${operation.quizId}/answer`, body: operation.body };
    case 'finalizeTimedQuiz':
      return { method: 'POST', path: `/quizzes/${operation.quizId}/finalize` };
    case 'retakeTimedQuiz':
      return { method: 'POST', path: `/quizzes/${operation.quizId}/retake` };
    case 'timedQuizFollowUps':
      return { method: 'POST', path: `/quizzes/${operation.quizId}/follow-ups` };
    case 'paperProgress':
      return { method: 'PUT', path: `/papers/${operation.paperId}/progress`, body: operation.body };
  }
}

export interface ApiResult {
  ok: boolean;
  status: number;
  data: unknown;
}

export interface SimulatedApiFailure {
  method: string;
  path: string;
  status: number;
  requestBody?: unknown;
  responseBody: unknown;
}

export class SimulatedApiFailureError extends Error {
  constructor(readonly request: SimulatedApiFailure) {
    super(
      `${request.method} ${request.path} failed (${request.status}); request=${JSON.stringify(request.requestBody)} response=${JSON.stringify(request.responseBody)}`,
    );
    this.name = 'SimulatedApiFailureError';
  }
}

export type SimulatorAfterCall = (
  method: string,
  path: string,
  now: Date,
  trace: readonly ImplicitRepetitionTraceEvent[],
) => Promise<void>;

/** Runs one simulated learner's operations against one copy of the app's learner rules. */
export interface SimulatorDriver {
  readonly userId: string | undefined;
  readonly failedRequests: SimulatedApiFailure[];
  readonly audit: SimulatorAudit;
  readonly fixtures: SimulatorFixtures;
  /** Runs after every operation, so audits can see the order of same-day events. */
  afterCall: SimulatorAfterCall | undefined;
  activityTrace: ((trace: readonly ImplicitRepetitionTraceEvent[]) => void) | undefined;
  call(operation: SimulatorOperation, now: Date): Promise<ApiResult>;
  require<T>(operation: SimulatorOperation, now: Date): Promise<T>;
  nextQuizTime(now: Date): Date;
  setContent(content: ContentIndex): void;
  cleanup(): Promise<void>;
}

export interface SimulatorDriverInput {
  content: ContentIndex;
  timeZone: string;
  initialNow: Date;
  profile: string;
}

export type SimulatorDriverFactory = (input: SimulatorDriverInput) => SimulatorDriver;

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function decisionSeed(...parts: Array<string | number>): number {
  let seed = 2_166_136_261;
  for (const character of parts.join('\u0000')) {
    seed = Math.imul(seed ^ character.charCodeAt(0), 16_777_619);
  }
  return seed >>> 0;
}

/** Gives each operation a stable key, so repeated runs draw the same random numbers. */
export class RequestRandomness {
  private readonly ordinals = new Map<string, number>();

  constructor(
    private readonly profile: string,
    private readonly localDate: (now: Date) => string,
  ) {}

  next(request: SimulatorHttpRequest, now: Date): () => number {
    const stablePath = request.path.replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '<id>',
    );
    const stableBody = JSON.stringify(request.body, (key, value: unknown) =>
      ['activityId', 'sessionId', 'problemId', 'itemId', 'placementId'].includes(key)
        ? `<${key}>`
        : value,
    );
    const day = this.localDate(now);
    const requestKey = `${day}|${request.method}|${stablePath}|${stableBody ?? ''}`;
    const ordinal = this.ordinals.get(requestKey) ?? 0;
    this.ordinals.set(requestKey, ordinal + 1);
    return seededRandom(decisionSeed(this.profile, day, 'api', requestKey, ordinal));
  }
}

/** Keeps timed-quiz request times strictly increasing within one learner. */
export class QuizClock {
  private quizTime = Number.NEGATIVE_INFINITY;

  next(now: Date): Date {
    this.quizTime = Math.max(now.getTime() + 1, this.quizTime + 1);
    return new Date(this.quizTime);
  }
}
