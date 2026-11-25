import type { ContentEdge, ContentIndex } from '@academy/aesop/course/types';
import { filterSchedulerStateForContent } from '@academy/aesop/graph/content-filters';
import { topicIsComplete } from '@academy/aesop/graph/course-status';
import { buildEncompassingIndex, type EncompassingIndex } from '@academy/aesop/graph/encompassing';
import {
  courseFoundationIds,
  createPrerequisiteChecker,
  keyPrereqsForPoint,
  masteryKey,
  prerequisiteMet,
} from '@academy/aesop/graph/prerequisites';
import { isLessonRetryReady } from '@academy/aesop/lessons/lesson-retry';
import {
  bringWeakestPrerequisiteCardDueNow,
  canBringPrerequisiteDueNow,
} from '@academy/aesop/lessons/prerequisite-review';
import {
  retrievability as fsrsRetrievability,
  isDueToday,
  newReviewCard,
  scheduleReview,
  startOfNextCalendarDay,
} from '@academy/aesop/memory/fsrs';
import { implicitRepetition } from '@academy/aesop/memory/implicit-repetition';
import {
  type ImplicitRepetitionTraceEvent,
  setImplicitRepetitionTrace,
} from '@academy/aesop/memory/mastery-service';
import { initialMastery, type MasteryState } from '@academy/aesop/memory/types';
import {
  adjustedMinutesForLearnerPace,
  explainReviewSelection,
  explainReviewSelectionForReplan,
  lessonRetryOverdue,
  type PlannedActivity,
  type ReviewSelectionExplanation,
  SCHEDULER_CONFIG,
  type SchedulerState,
} from '@academy/aesop/planner/scheduler';
import { localDateKey } from '@academy/aesop/progress/xp';
import { QUIZ_XP_INTERVAL, QUIZ_XP_WINDOW } from '@academy/aesop/quizzes/mixed-quiz';
import type { CourseCatalogPayload, CoursePayload, LearnPayload } from '@academy/contracts/course';
import type { QuizPayload } from '@academy/contracts/quizzes';
import type { SessionActivity, SessionPayload, TodayPayload } from '@academy/contracts/sessions';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Card } from 'ts-fsrs';
import { Rating, State } from 'ts-fsrs';
import { createApp } from '../src/app.js';
import type { Database } from '../src/db/client.js';
import { LearnerRepository } from '../src/db/repository.js';
import {
  lessonQuizAttempts,
  lessonQuizItems,
  lessonRuns,
  mastery,
  placementGrants,
  quizItems,
  quizRuns,
  remediationFlags,
  reviewCards,
  reviewLogs,
  sessionActivities,
  studySessions,
  users,
  xpEvents,
} from '../src/db/schema.js';
import {
  auditPlacementGrants,
  emptyPlacementAuditState,
  isOverplacedGap,
  type PlacementAuditState,
  recordLessonRunsAtWithdrawal,
  recordOverplacement,
  type SimulationPlacementGrantEvidence,
} from './learner-simulation-placement.js';
import { answerFor, exerciseFor, wrongAnswerFor } from './learner-simulation-support.js';

export const simulationProfiles = [
  'diligent',
  'average',
  'struggling',
  'forgetful',
  'placement',
  'graph-change',
  'gap',
  'scenario-p14-fallback',
  'scenario-p17-fallback',
  'scenario-p17-covering',
  'overplaced',
  'scenario-quizzes',
] as const;

export type SimulationProfile = (typeof simulationProfiles)[number];
export const scriptedScenarioProfiles = [
  'scenario-p14-fallback',
  'scenario-p17-fallback',
  'scenario-p17-covering',
] as const satisfies readonly SimulationProfile[];
const scriptedScenarioProfileSet: ReadonlySet<SimulationProfile> = new Set(
  scriptedScenarioProfiles,
);

function isScriptedScenarioProfile(profile: SimulationProfile): boolean {
  return scriptedScenarioProfileSet.has(profile);
}
export type InvariantId =
  | 'P1'
  | 'P2'
  | 'P3'
  | 'P4'
  | 'P5'
  | 'P6'
  | 'P7'
  | 'P8'
  | 'P9'
  | 'P10'
  | 'P11'
  | 'P12'
  | 'P13'
  | 'P14'
  | 'P15'
  | 'P16'
  | 'P17'
  | 'P18'
  | 'P19'
  | 'P20'
  | 'P21'
  | 'P22'
  | 'P23'
  | QuizInvariant;

type QuizInvariant = 'P24' | 'P25' | 'P26' | 'P27';
type CheckedInvariantId =
  | 'P13'
  | 'P14'
  | 'P15'
  | 'P16'
  | 'P17'
  | 'P18'
  | 'P19'
  | 'P20'
  | 'P21'
  | 'P22'
  | 'P23'
  | QuizInvariant;
type CheckedInvariantCounts = Record<CheckedInvariantId, number>;

export interface SimulationViolation {
  profile: SimulationProfile;
  day: number;
  invariant: InvariantId;
  entityId: string;
  courseId?: string;
  conceptId?: string;
  projectId?: string;
  missingAncestors: string[];
  startable?: boolean;
  details?: string;
  evidence: SimulationViolationEvidence;
}

export interface SimulationPlanEvidence {
  label: string;
  method: 'POST';
  path: string;
  requestBody: { budgetMinutes?: number; focusConceptId?: string };
  budgetMinutes: number;
  activities: Array<{
    activityId?: string;
    kind: string;
    conceptId?: string | null;
    projectId?: string;
    exerciseIds: string[];
    plannedMinutes: number;
    status?: string;
  }>;
  schedulerExplanations: ReviewSelectionExplanation[];
  retryDecisions: SimulationRetryDecisionEvidence[];
  behaviors: SimulationViolationEvidence['behaviors'];
  reviewCapMinutes: number;
  usedMinutes: number;
  remainingMinutes: number;
  remainingReviewCapMinutes: number;
}

export interface SimulationCardEvidence {
  cardId: string;
  conceptId: string;
  dimension: string;
  dueAt: string;
  state: number | null;
  lastReviewAt: string | null;
}

export interface SimulationLessonRunEvidence {
  conceptId: string;
  status: string;
  retryAfter?: string | null;
}

export interface SimulationRetryDecisionEvidence {
  conceptId: string;
  retryAfter: string;
  retryAfterPassed: true;
  overduePriority: boolean;
  eligible: boolean;
  candidateMinutes: number | null;
  preservedInProgressMinutes: number;
  reservedDueReviewMinutes: number;
  remainingCapacityMinutes: number;
  fitsRemainingCapacity: boolean | null;
  priorityRetryMinutes: number;
  priorityResumedLessonMinutes: number;
  priorityFocusLessonMinutes: number;
  remainingAfterSchedulerPriorityMinutes: number;
  fitsSchedulerCapacity: boolean;
  reservedDueReviews: Array<{
    conceptId: string;
    plannedMinutes: number;
    status?: string;
    explanationResult?: string;
    candidateMinutes?: number;
    reviewCap?: number;
    reviewMinutes?: number;
    overdueBypass: boolean;
  }>;
  selectedInstead: Array<{
    kind: string;
    conceptId: string | null;
    plannedMinutes: number;
    status?: string;
    retryStatus?: string;
    retryAfter?: string | null;
    overduePriority: boolean;
  }>;
}

export interface SimulationMasteryEvidence {
  conceptId: string;
  dimension: string;
  state: string;
  inferred: boolean;
}

export interface SimulationViolationEvidence {
  placementGrants?: SimulationPlacementGrantEvidence[];
  quiz?: Record<string, unknown>;
  beforeCards: SimulationCardEvidence[];
  afterCards: SimulationCardEvidence[];
  implicitRepetitionTrace: Array<ImplicitRepetitionTraceEvent & { activityOrder: number | null }>;
  prerequisiteResetEvidence: Array<{
    sourceCardId: string;
    sourceConceptId: string;
    sourceOrder: number;
    candidateCardIds: string[];
    eligibleCardIds: string[];
    selectedCardId: string | null;
  }>;
  activityLogs: Array<{
    cardId: string;
    conceptId: string;
    dimension?: string;
    rating: string;
    previousLog: { rating: string; createdAt: string } | null;
  }>;
  mastery: SimulationMasteryEvidence[];
  schedulerExplanations: ReviewSelectionExplanation[];
  budgetMinutes: number | null;
  reviewCapMinutes: number | null;
  usedMinutes: number | null;
  remainingMinutes: number | null;
  remainingReviewCapMinutes: number | null;
  behaviors: {
    B1BudgetMinutes: number | null;
    B2FocusConceptId: string | null;
    B3PartialExplain: boolean | null;
    B4Replan: boolean | null;
  };
  retryDecisions: SimulationRetryDecisionEvidence[];
  planActivities: SimulationPlanEvidence['activities'];
  lessonRuns: SimulationLessonRunEvidence[];
  planHistory: Array<{
    day: number;
    courseId: string | null;
    plans: SimulationPlanEvidence[];
    lessonRunStatuses: SimulationLessonRunEvidence[];
  }>;
}

export interface DailySimulationStats {
  day: number;
  date: string;
  courseId: string | null;
  studied: boolean;
  lessons: number;
  reviews: number;
  reviewAttempts: number;
  explicitReviews: number;
  positiveImplicitCredits: number;
  negativeImplicitCredits: number;
  coveredSkips: number;
  newTopicsCompleted: number;
  offers: SimulatedSessionOffer[];
  courseTopics: DailyCourseTopicState[];
  plans: SimulationPlanEvidence[];
  lessonRunStatuses: SimulationLessonRunEvidence[];
}

export interface SimulatedSessionOffer {
  kind: string;
  conceptId?: string;
  projectId?: string;
  paperId?: string;
  reviewTopics?: Array<{ conceptId: string; title: string }>;
}

export interface DailyCourseTopicState {
  conceptId: string;
  title: string;
  status: string;
  missingPrereqs: Array<{ id: string; title: string }>;
  retry?: { after: string | null; reviewFirst: Array<{ id: string; title: string }> };
}

export interface LessonHaltEvent {
  day: number;
  conceptId: string;
  pointId: string;
  noProgress: boolean;
}

export interface RemediationFlagEvent {
  day: number;
  conceptId: string;
  prerequisiteId: string;
}

export interface RemedialReviewEvent {
  day: number;
  conceptId: string;
  prerequisiteId: string;
}

export interface LessonRetryEvent {
  day: number;
  conceptId: string;
}

export interface GapLessonTimeline {
  conceptId: string;
  title: string;
  haltDays: number[];
  retryDays: number[];
  flagsOpened: Array<{ day: number; prerequisiteId: string }>;
  prereqsReviewed: Array<{ day: number; prerequisiteId: string }>;
  completionDays: number[];
}

export interface RemediationSimulationReport {
  totals: {
    halts: number;
    noProgressHalts: number;
    remediationFlagsOpened: number;
    remedialReviewsCompleted: number;
    retriesStarted: number;
    lessonsCompletedAfterRetry: number;
  };
  halts: LessonHaltEvent[];
  flagsOpened: RemediationFlagEvent[];
  remedialReviewsCompleted: RemedialReviewEvent[];
  retriesStarted: LessonRetryEvent[];
  lessonsCompletedAfterRetry: LessonRetryEvent[];
  gapTimeline?: GapLessonTimeline[];
}

export interface CourseSimulationSummary {
  courseId: string;
  title: string;
  startedDay: number | null;
  finishedDay: number | null;
  daysToFinish: number | null;
}

export interface SimulatedOffer {
  day: number;
  courseId: string;
  projectId: string;
}

export interface SimulatedPaper {
  day: number;
  courseId: string;
  paperId: string;
}

export interface ProfileSimulationReport {
  quizEvidence?: Array<{
    day: number;
    invariant: QuizInvariant;
    evidence: Record<string, unknown>;
  }>;
  profile: SimulationProfile;
  seed: number;
  dayCap: number;
  daysSimulated: number;
  finishedAllCourses: boolean;
  graphChangeDay?: number;
  courses: CourseSimulationSummary[];
  dailyStats: DailySimulationStats[];
  projectsOffered: SimulatedOffer[];
  papersRecorded: SimulatedPaper[];
  remediation: RemediationSimulationReport;
  p11CheckedEvents: number;
  p11AmbiguousEvents: number;
  checkedCounts: CheckedInvariantCounts;
  totals: {
    lessonsPerDayMean: number;
    lessonsPerDayMax: number;
    reviewsPerDayMean: number;
    reviewsPerDayMax: number;
    explicitReviews: number;
    positiveImplicitCredits: number;
    negativeImplicitCredits: number;
    coveredSkips: number;
    answers: number;
    wrongAnswers: number;
    wrongPercent: number;
  };
  violationCounts: Record<InvariantId, number>;
  violations: SimulationViolation[];
}

export interface LearnerSimulationReport {
  generatedAt: string;
  timeZone: string;
  dayCap: number;
  runtimeMs: number;
  profiles: ProfileSimulationReport[];
  skippedProfiles: Array<{ profile: SimulationProfile; reason: string }>;
}

export interface LearnerSimulationOptions {
  profiles: SimulationProfile[];
  days: number;
  courseIds?: string[];
  scenarioContent?: ContentIndex;
  timeZone?: string;
  startDate?: string;
  onProgress?: (message: string) => void;
}

interface ApiResult {
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

interface SimActivity extends SessionActivity {
  projectId?: string;
  paperId?: string;
}

interface LearnerProgress {
  masteryByKey: Map<string, { state: MasteryState; inferred: boolean }>;
  lessonRuns: Array<{
    conceptId: string;
    status: 'in_progress' | 'needs_retry' | 'quiz' | 'completed';
    retryAfter?: Date | null;
    haltedAt?: Date | null;
  }>;
  remediationFlags: Array<{ conceptId: string; targetPrereqId: string }>;
  placedOut: Set<string>;
}

interface ProfileRuntime {
  profile: SimulationProfile;
  seed: number;
  report: ProfileSimulationReport;
  violationKeys: Set<string>;
  offeredProjectKeys: Set<string>;
  lastPracticed: Map<string, number>;
  choiceStartability: Map<string, boolean>;
  answered: number;
  wrongAnswers: number;
  weakPrereqs: string[];
  completedRemedialReviews: Set<string>;
  lastHaltedPointIndex: Map<string, number>;
  haltEvents: LessonHaltEvent[];
  remediationFlagEvents: RemediationFlagEvent[];
  remedialReviewEvents: RemedialReviewEvent[];
  retryEvents: LessonRetryEvent[];
  postRetryCompletionEvents: LessonRetryEvent[];
  checkedReviewLogIds: Set<string>;
  pendingP18: Array<{ day: number; conceptId: string; sourceConceptId: string }>;
  openFlagKeys: Set<string>;
  awaitingRetryStart: Set<string>;
  retriedConcepts: Set<string>;
  completedAfterRetryConcepts: Set<string>;
  noProgressHalts: Map<
    string,
    { day: number; targetPrereqIds: string[]; reviewed: boolean; violationReported?: boolean }
  >;
  overdueRetryReported: Set<string>;
  activityKeyById: Map<string, string>;
  decisionAttempts: Map<string, number>;
  violationEvidenceContext: SimulationViolationEvidence;
  planEvidenceByDay: Map<number, SimulationPlanEvidence[]>;
  activeBehaviors: SimulationViolationEvidence['behaviors'];
  reviewActivityDimensionOrder: Map<string, Map<string, number>>;
  reviewActivityAttemptIndex: Map<string, number>;
  placement: PlacementAuditState;
}

const graphRemovedConcepts = new Set([
  'inverses-linear-systems',
  'rank-span',
  'orthogonality-projections',
]);
const graphCourseId = 'maths-for-ml';
const graphMilestoneConceptId = 'eigen-svd';
const invariants: InvariantId[] = [
  'P1',
  'P2',
  'P3',
  'P4',
  'P5',
  'P6',
  'P7',
  'P8',
  'P9',
  'P10',
  'P11',
  'P12',
  'P13',
  'P14',
  'P15',
  'P16',
  'P17',
  'P18',
  'P19',
  'P20',
  'P21',
  'P22',
  'P23',
  'P24',
  'P25',
  'P26',
  'P27',
];

const checkedInvariantIds: CheckedInvariantId[] = [
  'P13',
  'P14',
  'P15',
  'P16',
  'P17',
  'P18',
  'P19',
  'P20',
  'P21',
  'P22',
  'P23',
  'P24',
  'P25',
  'P26',
  'P27',
];

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numeric(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function decisionSeed(...parts: Array<string | number>): number {
  let seed = 2_166_136_261;
  for (const character of parts.join('\u0000')) {
    seed = Math.imul(seed ^ character.charCodeAt(0), 16_777_619);
  }
  return seed >>> 0;
}

function decisionRandom(
  profile: SimulationProfile,
  day: string | number,
  activityId: string,
  exerciseId: string,
  attempt: number,
): number {
  return seededRandom(decisionSeed(profile, day, activityId, exerciseId, attempt))();
}

function seedFor(profile: SimulationProfile): number {
  let seed = 2_166_136_261;
  for (const character of profile) {
    seed = Math.imul(seed ^ character.charCodeAt(0), 16_777_619);
  }
  return seed >>> 0;
}

function dateAfter(localDate: string, days: number): string {
  const date = new Date(`${localDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function localNoon(localDate: string, timeZone: string): Date {
  const [year = 0, month = 1, day = 1] = localDate.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day, 12);
  let timestamp = target;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]),
    );
    const localAsUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    timestamp += target - localAsUtc;
  }
  return new Date(timestamp);
}

function localDate(date: Date, timeZone: string): string {
  return localDateKey(date, timeZone);
}

function courseRows(catalog: CourseCatalogPayload) {
  return catalog.subjects.flatMap((subject) => subject.courses);
}

function coursePageTopics(page: CoursePayload) {
  return [...page.foundations, ...page.units.flatMap((unit) => unit.topics)];
}

function sessionOffer(activity: SimActivity): SimulatedSessionOffer {
  return {
    kind: activity.kind,
    ...(activity.conceptId ? { conceptId: activity.conceptId } : {}),
    ...(activity.projectId ? { projectId: activity.projectId } : {}),
    ...(activity.paperId ? { paperId: activity.paperId } : {}),
    ...(activity.reviewTopics ? { reviewTopics: activity.reviewTopics } : {}),
  };
}

function toGraphChangeContent(content: ContentIndex): ContentIndex {
  const concepts = content.concepts
    .filter((concept) => !graphRemovedConcepts.has(concept.id))
    .map((concept) =>
      concept.id === graphMilestoneConceptId
        ? {
            ...concept,
            prereqs: [
              { id: 'matrices', strength: 'hard' as const },
              { id: 'determinants', strength: 'hard' as const },
            ],
          }
        : concept,
    );
  const conceptsById = new Map(concepts.map((concept) => [concept.id, concept]));
  const courses = content.courses.map((course) => ({
    ...course,
    units: course.units.map((unit) => ({
      ...unit,
      concepts: unit.concepts.filter((conceptId) => !graphRemovedConcepts.has(conceptId)),
    })),
  }));
  const coursesById = new Map(courses.map((course) => [course.id, course]));
  const edges: ContentEdge[] = concepts.flatMap((concept) =>
    concept.prereqs.map((prerequisite) => ({
      conceptId: concept.id,
      prerequisiteId: prerequisite.id,
      strength: prerequisite.strength,
    })),
  );
  const confusablesById = new Map(
    [...content.confusablesById]
      .filter(([conceptId]) => conceptsById.has(conceptId))
      .map(([conceptId, related]) => [
        conceptId,
        new Set([...related].filter((relatedId) => conceptsById.has(relatedId))),
      ]),
  );
  return {
    ...content,
    concepts,
    conceptsById,
    courses,
    coursesById,
    edges,
    confusablesById,
  };
}

class SimulatedApi {
  private quizTime = Number.NEGATIVE_INFINITY;
  private app: ReturnType<typeof createApp>;
  private now: Date;
  /** Runs after every request, so audits can see the order of same-day events. */
  afterCall: (() => Promise<void>) | undefined;
  private cookie: string | undefined;
  private readonly requestOrdinals = new Map<string, number>();
  readonly failedRequests: SimulatedApiFailure[] = [];

  constructor(
    readonly db: Database,
    private content: ContentIndex,
    private readonly timeZone: string,
    initialNow: Date,
    private readonly profile: SimulationProfile,
  ) {
    this.now = initialNow;
    this.app = this.createApp();
  }

  private createApp() {
    return createApp({
      db: this.db,
      content: this.content,
      demo: { ttlHours: 9_600 },
      tutorProvider: null,
      authClock: () => this.now,
    });
  }

  setContent(content: ContentIndex) {
    this.content = content;
    this.app = this.createApp();
  }

  get userId(): string | undefined {
    return this.cookie?.match(/^academy_demo=([^;]+)/)?.[1];
  }

  nextQuizTime(now: Date): Date {
    this.quizTime = Math.max(now.getTime() + 1, this.quizTime + 1);
    return new Date(this.quizTime);
  }

  async call(method: string, path: string, now: Date, body?: unknown): Promise<ApiResult> {
    this.now = now;
    const stablePath = path.replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '<id>',
    );
    const stableBody = JSON.stringify(body, (key, value: unknown) =>
      ['activityId', 'sessionId', 'problemId', 'itemId', 'placementId'].includes(key)
        ? `<${key}>`
        : value,
    );
    const requestKey = `${localDate(now, this.timeZone)}|${method}|${stablePath}|${stableBody ?? ''}`;
    const ordinal = this.requestOrdinals.get(requestKey) ?? 0;
    this.requestOrdinals.set(requestKey, ordinal + 1);
    const originalRandom = Math.random;
    const apiSeed = decisionSeed(
      this.profile,
      localDate(now, this.timeZone),
      'api',
      requestKey,
      ordinal,
    );
    Math.random = seededRandom(apiSeed);
    const headers = new Headers({
      'X-Now': now.toISOString(),
      'X-Time-Zone': this.timeZone,
    });
    if (this.cookie) headers.set('cookie', this.cookie);
    if (body !== undefined) headers.set('content-type', 'application/json');
    try {
      const response = await this.app.request(`http://academy.local/api${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) this.cookie = setCookie.split(';', 1)[0];
      let data: unknown = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (response.status >= 500) {
        const failure: SimulatedApiFailure = {
          method,
          path,
          status: response.status,
          ...(body === undefined ? {} : { requestBody: body }),
          responseBody: data,
        };
        this.failedRequests.push(failure);
        throw new SimulatedApiFailureError(failure);
      }
      await this.afterCall?.();
      return { ok: response.ok, status: response.status, data };
    } finally {
      Math.random = originalRandom;
    }
  }

  async require<T>(method: string, path: string, now: Date, body?: unknown): Promise<T> {
    const result = await this.call(method, path, now, body);
    if (!result.ok) {
      throw new Error(
        `${method} ${path} failed (${result.status}): ${JSON.stringify(result.data)}`,
      );
    }
    return result.data as T;
  }

  async cleanup() {
    if (this.userId) {
      await this.db.delete(users).where(eq(users.id, this.userId));
    }
  }
}

function hardAncestorClosure(
  conceptIds: readonly string[],
  content: ContentIndex,
  includeRoots: boolean,
): string[] {
  const ancestors = new Set<string>();
  const visited = new Set<string>();
  const visit = (conceptId: string) => {
    if (visited.has(conceptId)) return;
    visited.add(conceptId);
    const concept = content.conceptsById.get(conceptId);
    for (const prerequisite of concept?.prereqs ?? []) {
      if (prerequisite.strength !== 'hard') continue;
      ancestors.add(prerequisite.id);
      visit(prerequisite.id);
    }
  };
  for (const conceptId of conceptIds) {
    if (includeRoots) ancestors.add(conceptId);
    visit(conceptId);
  }
  return [...ancestors];
}

async function readProgress(db: Database, userId: string): Promise<LearnerProgress> {
  const [masteryRows, runs, placements, flags] = await Promise.all([
    db
      .select()
      .from(mastery)
      .where(eq(mastery.userId, userId))
      .orderBy(asc(mastery.conceptId), asc(mastery.dimension)),
    db
      .select()
      .from(lessonRuns)
      .where(eq(lessonRuns.userId, userId))
      .orderBy(asc(lessonRuns.conceptId), desc(lessonRuns.startedAt), desc(lessonRuns.id)),
    db
      .select({ conceptId: placementGrants.conceptId, state: placementGrants.state })
      .from(placementGrants)
      .where(eq(placementGrants.userId, userId))
      .orderBy(asc(placementGrants.createdAt), asc(placementGrants.id)),
    db
      .select()
      .from(remediationFlags)
      .where(and(eq(remediationFlags.userId, userId), eq(remediationFlags.status, 'open')))
      .orderBy(
        asc(remediationFlags.conceptId),
        asc(remediationFlags.targetPrereqId),
        asc(remediationFlags.id),
      ),
  ]);
  const placedOut = new Set<string>();
  for (const grant of placements) {
    if (grant.state === 'withdrawn') placedOut.delete(grant.conceptId);
    else placedOut.add(grant.conceptId);
  }
  return {
    masteryByKey: new Map(
      masteryRows.map((record) => [
        masteryKey(record.conceptId, record.dimension),
        { state: record.state, inferred: record.inferred },
      ]),
    ),
    lessonRuns: runs.map(({ conceptId, status, retryAfter, haltedAt }) => ({
      conceptId,
      status,
      retryAfter,
      haltedAt,
    })),
    remediationFlags: flags.flatMap((flag) =>
      flag.targetPrereqId
        ? [{ conceptId: flag.conceptId, targetPrereqId: flag.targetPrereqId }]
        : [],
    ),
    placedOut,
  };
}

function isDone(
  conceptId: string,
  progress: Pick<LearnerProgress, 'masteryByKey' | 'lessonRuns'>,
  content: ContentIndex,
): boolean {
  return prerequisiteMet(conceptId, progress.masteryByKey, progress.lessonRuns, content);
}

function questionWasLearned(
  conceptId: string,
  progress: LearnerProgress,
  content: ContentIndex,
): boolean {
  const run = progress.lessonRuns.find((item) => item.conceptId === conceptId);
  return (
    run?.status === 'completed' ||
    run?.status === 'quiz' ||
    progress.placedOut.has(conceptId) ||
    progress.masteryByKey.get(masteryKey(conceptId, 'concept'))?.inferred === true ||
    isDone(conceptId, progress, content)
  );
}

function addViolation(
  runtime: ProfileRuntime,
  day: number,
  invariant: InvariantId,
  entityId: string,
  missingAncestors: string[],
  fields: Pick<
    SimulationViolation,
    'courseId' | 'conceptId' | 'projectId' | 'startable' | 'details'
  > & { evidenceConceptIds?: string[]; placementGrants?: SimulationPlacementGrantEvidence[] } = {},
) {
  const key = `${day}|${invariant}|${entityId}|${fields.details ?? ''}`;
  if (runtime.violationKeys.has(key)) return;
  runtime.violationKeys.add(key);
  const { evidenceConceptIds = [], placementGrants: grantEvidence, ...violationFields } = fields;
  const context = runtime.violationEvidenceContext;
  const relatedConceptIds = new Set([
    fields.conceptId ?? entityId.split('/')[0] ?? entityId,
    ...missingAncestors,
    ...evidenceConceptIds,
  ]);
  const schedulerExplanations = context.schedulerExplanations.filter(
    ({ conceptId, coveringConceptId }) =>
      relatedConceptIds.has(conceptId) ||
      (coveringConceptId !== undefined && relatedConceptIds.has(coveringConceptId)),
  );
  const relatedCardIds = new Set(
    [...context.beforeCards, ...context.afterCards]
      .filter((card) => relatedConceptIds.has(card.conceptId))
      .map(({ cardId }) => cardId),
  );
  for (const explanation of schedulerExplanations) {
    relatedConceptIds.add(explanation.conceptId);
    if (explanation.coveringConceptId) relatedConceptIds.add(explanation.coveringConceptId);
  }
  const evidence: SimulationViolationEvidence = {
    ...context,
    beforeCards: context.beforeCards.filter((card) => relatedConceptIds.has(card.conceptId)),
    afterCards: context.afterCards.filter((card) => relatedConceptIds.has(card.conceptId)),
    implicitRepetitionTrace:
      invariant === 'P15'
        ? context.implicitRepetitionTrace.filter(
            (event) =>
              relatedConceptIds.has(event.sourceConceptId) &&
              relatedCardIds.has(event.targetCardId),
          )
        : [],
    prerequisiteResetEvidence:
      invariant === 'P15'
        ? context.prerequisiteResetEvidence.filter(
            (reset) =>
              relatedConceptIds.has(reset.sourceConceptId) ||
              reset.candidateCardIds.some((cardId) => relatedCardIds.has(cardId)),
          )
        : [],
    activityLogs: context.activityLogs.filter((log) => relatedConceptIds.has(log.conceptId)),
    mastery: context.mastery.filter((record) => relatedConceptIds.has(record.conceptId)),
    schedulerExplanations,
    retryDecisions:
      invariant === 'P10'
        ? context.retryDecisions.filter(({ conceptId }) => relatedConceptIds.has(conceptId))
        : [],
    ...(grantEvidence ? { placementGrants: grantEvidence } : {}),
  };
  runtime.report.violations.push({
    profile: runtime.profile,
    day,
    invariant,
    entityId,
    missingAncestors,
    ...violationFields,
    evidence,
  });
}

function emptyViolationEvidence(): SimulationViolationEvidence {
  return {
    beforeCards: [],
    afterCards: [],
    implicitRepetitionTrace: [],
    prerequisiteResetEvidence: [],
    activityLogs: [],
    mastery: [],
    schedulerExplanations: [],
    budgetMinutes: null,
    reviewCapMinutes: null,
    usedMinutes: null,
    remainingMinutes: null,
    remainingReviewCapMinutes: null,
    behaviors: {
      B1BudgetMinutes: null,
      B2FocusConceptId: null,
      B3PartialExplain: null,
      B4Replan: null,
    },
    retryDecisions: [],
    planActivities: [],
    lessonRuns: [],
    planHistory: [],
  };
}

function setP5EvidenceContext(runtime: ProfileRuntime, day: number) {
  const firstDay = Math.max(1, day - 6);
  runtime.violationEvidenceContext = {
    ...runtime.violationEvidenceContext,
    planHistory: runtime.report.dailyStats
      .filter((daily) => daily.day >= firstDay && daily.day <= day)
      .map((daily) => ({
        day: daily.day,
        courseId: daily.courseId,
        plans: daily.plans,
        lessonRunStatuses: daily.lessonRunStatuses,
      })),
  };
}

function schedulerCardEvidence(state: SchedulerState, _now: Date): SimulationCardEvidence[] {
  return state.cards.map((card) => {
    const lastReviewAt = card.fsrs?.last_review;
    const lastReviewDate =
      lastReviewAt instanceof Date
        ? lastReviewAt
        : typeof lastReviewAt === 'string'
          ? new Date(lastReviewAt)
          : undefined;
    return {
      cardId: dueCardKey(card),
      conceptId: card.conceptId,
      dimension: card.dimension,
      dueAt: card.dueAt,
      state: card.fsrs?.state ?? null,
      lastReviewAt:
        lastReviewDate && !Number.isNaN(lastReviewDate.getTime())
          ? lastReviewDate.toISOString()
          : null,
    };
  });
}

function databaseCardEvidence(
  cards: readonly {
    id: string;
    conceptId: string;
    dimension: string;
    dueAt: Date;
    lastReviewAt: Date | null;
    fsrs: unknown;
  }[],
): SimulationCardEvidence[] {
  return cards.map((card) => ({
    cardId: dueCardKey(card),
    conceptId: card.conceptId,
    dimension: card.dimension,
    dueAt: card.dueAt.toISOString(),
    state:
      card.fsrs &&
      typeof card.fsrs === 'object' &&
      'state' in card.fsrs &&
      typeof card.fsrs.state === 'number'
        ? card.fsrs.state
        : null,
    lastReviewAt: card.lastReviewAt?.toISOString() ?? null,
  }));
}

function markChecked(runtime: ProfileRuntime, invariant: CheckedInvariantId) {
  runtime.report.checkedCounts[invariant] += 1;
}

export function p13HasEmptyPlanViolation(
  activityCount: number,
  unlockedLessonMinutes: readonly number[],
  budgetMinutes: number,
): boolean {
  return (
    activityCount === 0 &&
    unlockedLessonMinutes.some((plannedMinutes) => plannedMinutes <= budgetMinutes)
  );
}

// Matches the overdue review-cap bypass in scheduler.ts:1076.
export function reviewFeasible(
  minutes: number,
  remainingBudget: number,
  remainingCap: number,
  overdueDays: number,
): boolean {
  return (
    Number.isFinite(minutes) &&
    minutes > 0 &&
    minutes <= remainingBudget &&
    (overdueDays >= 2 || minutes <= remainingCap)
  );
}

export function p5HasNoWorkWindow(
  dailyStats: readonly Pick<DailySimulationStats, 'day' | 'lessons' | 'reviewAttempts'>[],
  endDay: number,
  remedialReviewDays: ReadonlySet<number>,
): boolean {
  const statsByDay = new Map(dailyStats.map((item) => [item.day, item]));
  for (let day = endDay - 6; day <= endDay; day += 1) {
    const stats = statsByDay.get(day);
    if (!stats || stats.lessons > 0 || stats.reviewAttempts > 0 || remedialReviewDays.has(day)) {
      return false;
    }
  }
  return true;
}

export function p10MissingOverdueRetryConcepts(
  state: SchedulerState,
  eligibleConceptIds: ReadonlySet<string>,
  plannedConceptIds: ReadonlySet<string>,
  now: Date,
  fitsSchedulerCapacity?: ReadonlyMap<string, boolean>,
): string[] {
  return (state.lessonRuns ?? [])
    .filter(
      ({ conceptId }) =>
        eligibleConceptIds.has(conceptId) &&
        !plannedConceptIds.has(conceptId) &&
        lessonRetryOverdue(state, conceptId, now) &&
        (!fitsSchedulerCapacity || fitsSchedulerCapacity.get(conceptId) === true),
    )
    .map(({ conceptId }) => conceptId);
}

export function p10RetryFitsCapacity(
  candidateMinutes: number | null,
  budgetMinutes: number,
  preservedInProgressMinutes: number,
  reservedDueReviewMinutes: number,
  alreadySelectedSchedulerPriorityMinutes: number,
): boolean {
  return (
    candidateMinutes !== null &&
    Number.isFinite(candidateMinutes) &&
    candidateMinutes > 0 &&
    candidateMinutes <=
      budgetMinutes -
        preservedInProgressMinutes -
        reservedDueReviewMinutes -
        alreadySelectedSchedulerPriorityMinutes
  );
}

export function p10PreservedActivityMinutes(
  activities: readonly Pick<SimActivity, 'id' | 'status' | 'plannedMinutes'>[],
  carriedOverActivityIds: ReadonlySet<string>,
): number {
  return activities
    .filter(
      (activity) =>
        carriedOverActivityIds.has(activity.id) &&
        (activity.status === 'in_progress' || activity.status === 'completed'),
    )
    .reduce((total, activity) => total + activity.plannedMinutes, 0);
}

export function p10SchedulerPriorityLessonMinutes(
  state: SchedulerState,
  retryConceptId: string,
  now: Date,
  activities: readonly SimActivity[],
  carriedOverActivityIds: ReadonlySet<string>,
): {
  overdueRetryMinutes: number;
  resumedLessonMinutes: number;
  focusLessonMinutes: number;
  totalMinutes: number;
} {
  const runsByConcept = new Map((state.lessonRuns ?? []).map((run) => [run.conceptId, run]));
  const candidates = activities.filter(
    (activity) =>
      activity.kind === 'learn' &&
      activity.conceptId &&
      activity.conceptId !== retryConceptId &&
      !carriedOverActivityIds.has(activity.id),
  );
  const overdueRetryActivities = candidates.filter((activity) => {
    const conceptId = activity.conceptId;
    return (
      conceptId !== null &&
      conceptId !== undefined &&
      runsByConcept.get(conceptId)?.status === 'needs_retry' &&
      lessonRetryOverdue(state, conceptId, now)
    );
  });
  const resumedLessonActivities = candidates.filter((activity) => {
    const status = activity.conceptId ? runsByConcept.get(activity.conceptId)?.status : undefined;
    return status === 'in_progress' || status === 'quiz';
  });
  const prioritizedActivityIds = new Set([
    ...overdueRetryActivities.map(({ id }) => id),
    ...resumedLessonActivities.map(({ id }) => id),
  ]);
  const focusedLessonActivities = candidates.filter(
    (activity) =>
      activity.conceptId === state.inProgressConceptId && !prioritizedActivityIds.has(activity.id),
  );
  const minutes = (selected: readonly SimActivity[]) =>
    selected.reduce((total, activity) => total + activity.plannedMinutes, 0);
  const overdueRetryMinutes = minutes(overdueRetryActivities);
  const resumedLessonMinutes = minutes(resumedLessonActivities);
  const focusLessonMinutes = minutes(focusedLessonActivities);
  return {
    overdueRetryMinutes,
    resumedLessonMinutes,
    focusLessonMinutes,
    totalMinutes: overdueRetryMinutes + resumedLessonMinutes + focusLessonMinutes,
  };
}

export function p10EligibleConceptIds(
  state: SchedulerState,
  content: ContentIndex,
  now: Date,
): Set<string> {
  const courseIds =
    state.studyCourseIds.length > 0
      ? state.studyCourseIds
      : state.activeCourseId
        ? [state.activeCourseId]
        : [];
  const outlineConceptIds = new Set(
    courseIds.flatMap((courseId) => {
      const course = content.coursesById.get(courseId);
      return [
        ...(course?.units.flatMap((unit) => unit.concepts) ?? []),
        ...courseFoundationIds(content, courseId),
      ];
    }),
  );
  const masteryByKey = new Map(
    state.mastery.map(
      (record) => [masteryKey(record.conceptId, record.dimension), record] as const,
    ),
  );
  const lessonRuns = state.lessonRuns ?? [];
  const runsByConcept = new Map(lessonRuns.map((run) => [run.conceptId, run]));
  const masteryByConcept = new Map<string, SchedulerState['mastery']>();
  for (const record of state.mastery) {
    const records = masteryByConcept.get(record.conceptId) ?? [];
    records.push(record);
    masteryByConcept.set(record.conceptId, records);
  }
  const prerequisiteChecker = createPrerequisiteChecker(masteryByKey, lessonRuns, content);
  return new Set(
    [...outlineConceptIds].filter((conceptId) => {
      const concept = content.conceptsById.get(conceptId);
      const run = runsByConcept.get(conceptId);
      const hasOpenFlags = (state.remediationFlags ?? []).some(
        (flag) =>
          flag.conceptId === conceptId && (flag.status === undefined || flag.status === 'open'),
      );
      const dimensionStates =
        concept?.dimensions.map(
          (dimension) =>
            masteryByConcept.get(conceptId)?.find((record) => record.dimension === dimension)
              ?.state ?? 'not_assessed',
        ) ?? [];
      return (
        concept !== undefined &&
        content.lessonsByConcept.has(conceptId) &&
        concept.status !== 'stub' &&
        !topicIsComplete(run?.status, dimensionStates) &&
        prerequisiteChecker.chainReady(conceptId) &&
        (run?.status !== 'needs_retry' || isLessonRetryReady(run.retryAfter, hasOpenFlags, now))
      );
    }),
  );
}

export function p6HasFeasibleOverdueReview(
  overdueDays: number,
  reviewMinutes: number,
  remainingBudget: number,
  remainingCap: number,
): boolean {
  return (
    overdueDays > 7 && reviewFeasible(reviewMinutes, remainingBudget, remainingCap, overdueDays)
  );
}

export function planUsageMinutes(
  activities: readonly Pick<SimActivity, 'kind' | 'plannedMinutes' | 'status'>[],
  replan: boolean,
): { usedMinutes: number; usedReviewMinutes: number } {
  const chargeable = activities.filter(
    (activity) =>
      activity.status !== 'completed' &&
      activity.status !== 'skipped' &&
      !(replan && activity.status === 'in_progress'),
  );
  return {
    usedMinutes: chargeable.reduce((total, activity) => total + activity.plannedMinutes, 0),
    usedReviewMinutes: chargeable
      .filter((activity) => activity.kind === 'review')
      .reduce((total, activity) => total + activity.plannedMinutes, 0),
  };
}

export function p18PlanCoversTopic(
  coveringActivities: readonly Pick<SimActivity, 'kind' | 'status'>[],
  selectedReviewMinutes: number,
  remainingBudget: number,
  remainingReviewCap: number,
  overdueDays: number,
): boolean {
  return coveringActivities.some(
    (activity) =>
      activity.kind !== 'review' ||
      activity.status === 'in_progress' ||
      reviewFeasible(selectedReviewMinutes, remainingBudget, remainingReviewCap, overdueDays),
  );
}

export function newActivitiesForReplan<T extends Pick<SimActivity, 'id' | 'status'>>(
  activities: readonly T[],
  originalActivityIds: ReadonlySet<string>,
): T[] {
  return activities.filter(
    (activity) =>
      activity.status === 'planned' ||
      (activity.status === 'in_progress' && !originalActivityIds.has(activity.id)),
  );
}

export function scenarioCourseFilterSkipReason(
  profile: SimulationProfile,
  courseIds: readonly string[] | undefined,
  fixtureCourseId: string | undefined,
): string | undefined {
  if (
    !isScriptedScenarioProfile(profile) ||
    !courseIds ||
    !fixtureCourseId ||
    courseIds.includes(fixtureCourseId)
  ) {
    return undefined;
  }
  return `fixture course ${fixtureCourseId} is not included in --courses`;
}

export function validateSimulationCourseIds(
  courseIds: readonly string[] | undefined,
  contentCourseIds: ReadonlySet<string>,
  scenarioCourseIds: readonly string[] = [],
): void {
  const validCourseIds = new Set([...contentCourseIds, ...scenarioCourseIds]);
  for (const courseId of courseIds ?? []) {
    if (!validCourseIds.has(courseId)) {
      throw new Error(`Unknown course ID in --courses: ${courseId}`);
    }
  }
}

function p14ExplanationForCard(
  card: { conceptId: string; dimension: string },
  explanations: readonly ReviewSelectionExplanation[],
): ReviewSelectionExplanation | undefined {
  return explanations.find(
    ({ conceptId, result, exerciseDimensions }) =>
      conceptId === card.conceptId &&
      exerciseDimensions.includes(card.dimension) &&
      (result === 'covered' || result === 'selected' || result === 'selected:overdue'),
  );
}

export function p14UncoveredDueCards(
  dueCards: readonly { cardId: string; conceptId: string; dimension: string }[],
  activityCoverage: readonly {
    conceptIds: readonly string[];
    cardIds: ReadonlySet<string>;
    selectedCardIds: ReadonlySet<string>;
    unfinished: boolean;
  }[],
  explanations: readonly ReviewSelectionExplanation[],
): string[] {
  return dueCards.flatMap(({ cardId, conceptId, dimension }) => {
    const explanation = p14ExplanationForCard({ conceptId, dimension }, explanations);
    if (!explanation) return [];
    const covered = activityCoverage.some(({ conceptIds, cardIds, selectedCardIds, unfinished }) =>
      explanation.result === 'covered'
        ? cardIds.has(cardId) &&
          unfinished &&
          explanation.coveringConceptId !== undefined &&
          conceptIds.includes(explanation.coveringConceptId)
        : selectedCardIds.has(cardId),
    );
    return covered ? [] : [cardId];
  });
}

export function reviewOverdueDaysForAudit(
  cards: readonly Pick<SchedulerState['cards'][number], 'conceptId' | 'dimension' | 'dueAt'>[],
  conceptId: string,
  now: Date,
  timeZone: string,
  exerciseDimensions?: readonly string[],
): number {
  const today = localDayOrdinal(now, timeZone);
  return Math.max(
    0,
    ...cards
      .filter(
        (card) =>
          card.conceptId === conceptId &&
          (!exerciseDimensions || exerciseDimensions.includes(card.dimension)),
      )
      .map((card) => today - localDayOrdinal(new Date(card.dueAt), timeZone)),
  );
}

export function p16HasOverduePrecedenceViolation(
  droppedReviewOverdueDays: number,
  selectedReviewOverdueDays: number,
  droppedReviewMinutes: number,
  remainingBudgetMinutes: number,
  remainingReviewCapMinutes: number,
  selectedReviewMinutes: number,
): boolean {
  return (
    droppedReviewOverdueDays >= selectedReviewOverdueDays + 2 &&
    reviewFeasible(
      droppedReviewMinutes,
      remainingBudgetMinutes + selectedReviewMinutes,
      remainingReviewCapMinutes + selectedReviewMinutes,
      droppedReviewOverdueDays,
    )
  );
}

export function p17ReviewFitsRemaining(
  reviewMinutes: number,
  remainingBudgetMinutes: number,
  remainingReviewCapMinutes: number,
  overdueDays: number,
): boolean {
  return reviewFeasible(
    reviewMinutes,
    remainingBudgetMinutes,
    remainingReviewCapMinutes,
    overdueDays,
  );
}

function scriptedScenarioContent(profile: SimulationProfile, content: ContentIndex): ContentIndex {
  const concepts = content.concepts.map((concept) => {
    if (concept.id === 'supervised-learning') {
      const weight =
        profile === 'scenario-p14-fallback'
          ? 1
          : profile === 'scenario-p17-covering'
            ? 0.02
            : undefined;
      return {
        ...concept,
        est_minutes: 15,
        encompassings: [
          ...(concept.encompassings ?? []).filter(({ id }) => id !== 'vectors'),
          ...(weight === undefined ? [] : [{ id: 'vectors', weight }]),
        ],
      };
    }
    if (profile === 'scenario-p17-covering' && concept.id === 'vectors') {
      return {
        ...concept,
        encompassings: [
          ...(concept.encompassings ?? []).filter(({ id }) => id !== 'linear-models'),
          { id: 'linear-models', weight: 0.1 },
        ],
      };
    }
    return concept;
  });
  const exercises = content.exercises.map((exercise) => {
    if (exercise.concept === 'vectors' && exercise.dimension === 'math') {
      return { ...exercise, est_minutes: 3 };
    }
    if (
      exercise.concept === 'linear-models' &&
      exercise.dimension === 'math' &&
      profile === 'scenario-p17-covering'
    ) {
      return { ...exercise, est_minutes: 8 };
    }
    return exercise;
  });
  const conceptsById = new Map(concepts.map((concept) => [concept.id, concept]));
  const exercisesById = new Map(exercises.map((exercise) => [exercise.id, exercise]));
  const updateExercises = (items: typeof exercises) =>
    items.map((exercise) => exercisesById.get(exercise.id) ?? exercise);
  return {
    ...content,
    concepts,
    conceptsById,
    exercises,
    exercisesById,
    exercisesByConcept: new Map(
      [...content.exercisesByConcept].map(([conceptId, items]) => [
        conceptId,
        updateExercises(items),
      ]),
    ),
    exercisesByDimension: new Map(
      [...content.exercisesByDimension].map(([dimension, items]) => [
        dimension,
        updateExercises(items),
      ]),
    ),
    exercisesByRole: new Map(
      [...content.exercisesByRole].map(([role, items]) => [role, updateExercises(items)]),
    ),
  };
}

function scriptedScenarioReviewCard(
  userId: string,
  conceptId: string,
  dueAt: Date,
  stability: number,
  targetRetrievability?: number,
): typeof reviewCards.$inferInsert {
  const reviewedAt = new Date(
    dueAt.getTime() - (targetRetrievability === undefined ? 44 : 5_000) * 86_400_000,
  );
  const scheduled = scheduleReview(
    newReviewCard(reviewedAt),
    reviewedAt,
    Rating.Good,
    'UTC',
    false,
  ).card;
  if (targetRetrievability !== undefined) {
    let lower = 0.001;
    let upper = 1_000_000;
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const candidate = (lower + upper) / 2;
      const candidateRetrievability = fsrsRetrievability(
        { ...scheduled, stability: candidate },
        dueAt,
        process.env.NODE_ENV !== 'test',
      );
      if (candidateRetrievability < targetRetrievability) {
        lower = candidate;
      } else {
        upper = candidate;
      }
    }
    stability = (lower + upper) / 2;
  }
  return {
    userId,
    conceptId,
    dimension: 'math',
    fsrs: { ...scheduled, state: State.Review, stability, due: dueAt },
    dueAt,
    lastReviewAt: reviewedAt,
    reps: scheduled.reps,
    lapses: scheduled.lapses,
  };
}

async function seedScriptedScenario(
  db: Database,
  userId: string,
  profile: SimulationProfile,
  content: ContentIndex,
  now: Date,
): Promise<void> {
  const freshConceptId = 'supervised-learning';
  await new LearnerRepository(db, userId).startCourse('fixture-course', 'beginning', now);
  await db
    .update(users)
    .set({
      activeCourseId: 'fixture-course',
      studySetInitializedAt: now,
      timezone: 'UTC',
      startDate: '2026-01-05',
    })
    .where(eq(users.id, userId));
  await db.delete(reviewCards).where(eq(reviewCards.userId, userId));
  await db.delete(lessonRuns).where(eq(lessonRuns.userId, userId));
  await db.delete(mastery).where(eq(mastery.userId, userId));
  const masteryRows = content.concepts
    .filter((concept) => concept.id !== freshConceptId)
    .flatMap((concept) =>
      concept.dimensions.map((dimension) => {
        const record = initialMastery(concept.id, dimension);
        return {
          userId,
          conceptId: concept.id,
          dimension,
          state: 'independent' as const,
          provisional: false,
          inferred: false,
          evidence: {
            independentItemIds: record.independentItemIds,
            independentDeterministicCount: 1,
            lastIndependentCorrect: true,
            attempts: record.attempts,
          },
          lastAssessedAt: now,
          lastIndependentAt: now,
          firstIndependentAt: now,
        };
      }),
    );
  await db.insert(mastery).values(masteryRows);
  const cards =
    profile === 'scenario-p14-fallback'
      ? [scriptedScenarioReviewCard(userId, 'vectors', now, 30)]
      : profile === 'scenario-p17-covering'
        ? [
            scriptedScenarioReviewCard(userId, 'vectors', now, 30),
            scriptedScenarioReviewCard(userId, 'linear-models', now, 30),
          ]
        : [
            scriptedScenarioReviewCard(
              userId,
              'vectors',
              new Date(now.getTime() - 2 * 86_400_000),
              30,
            ),
          ];
  await db.insert(reviewCards).values(cards);
}

export function requireP17ReviewMinutes(conceptId: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      `P17 audit requires positive review minutes for ${conceptId}; received ${value}`,
    );
  }
  return value;
}

export function p18HasMissedPickup(
  remainsDue: boolean,
  hasReviewLog: boolean,
  planCoversTopic: boolean,
  reviewMinutes: number,
  remainingBudgetMinutes: number,
  remainingReviewCapMinutes: number,
  overdueDays: number,
): boolean {
  return (
    remainsDue &&
    !hasReviewLog &&
    !planCoversTopic &&
    reviewFeasible(reviewMinutes, remainingBudgetMinutes, remainingReviewCapMinutes, overdueDays)
  );
}

export function selectedReviewConceptsForAudit(
  conceptIds: readonly string[],
  explanations: readonly Pick<
    ReviewSelectionExplanation,
    'conceptId' | 'result' | 'selectionOrder'
  >[],
): string[] {
  const selectedConcepts = new Map(
    explanations
      .filter(({ result }) => result === 'selected' || result === 'selected:overdue')
      .map(({ conceptId, selectionOrder }) => [conceptId, selectionOrder ?? Infinity]),
  );
  return [...new Set(conceptIds)]
    .filter((conceptId) => selectedConcepts.has(conceptId))
    .sort(
      (left, right) =>
        (selectedConcepts.get(left) ?? Infinity) - (selectedConcepts.get(right) ?? Infinity),
    );
}

export function p19HasEarlyReviewViolation(
  ownConceptIsDue: boolean,
  newlyCoveredDueTopics: number,
  remediation: boolean,
): boolean {
  return !remediation && !ownConceptIsDue && newlyCoveredDueTopics < 2;
}

interface AuditDueCoverageContext {
  weights: EncompassingIndex;
  timezone: string;
  nextLocalDay: Date;
  dueCardsByConcept: Map<string, SchedulerState['cards']>;
}

const auditDueCoverageContexts = new WeakMap<
  SchedulerState,
  { content: ContentIndex; nowMs: number; context: AuditDueCoverageContext }
>();

function dueTopicsCoveredByForAudit(
  taskConceptId: string,
  state: SchedulerState,
  content: ContentIndex,
  now: Date,
): Set<string> {
  let cached = auditDueCoverageContexts.get(state);
  if (!cached || cached.content !== content || cached.nowMs !== now.getTime()) {
    const timezone = state.timezone ?? 'UTC';
    const dueCardsByConcept = new Map<string, SchedulerState['cards']>();
    for (const card of state.cards) {
      if (!isDueToday(card.dueAt, now, timezone)) continue;
      const dueCards = dueCardsByConcept.get(card.conceptId) ?? [];
      dueCards.push(card);
      dueCardsByConcept.set(card.conceptId, dueCards);
    }
    cached = {
      content,
      nowMs: now.getTime(),
      context: {
        weights: buildEncompassingIndex(content),
        timezone,
        nextLocalDay: startOfNextCalendarDay(now, timezone),
        dueCardsByConcept,
      },
    };
    auditDueCoverageContexts.set(state, cached);
  }

  const covered = new Set<string>();
  for (const [dueConceptId, dueCards] of cached.context.dueCardsByConcept) {
    if (dueConceptId === taskConceptId) continue;
    const weight = cached.context.weights.weight(taskConceptId, dueConceptId);
    if (weight <= 0) continue;
    if (
      dueCards.every((card) => {
        if (!card.fsrs) return false;
        const update = implicitRepetition(
          { fsrs: card.fsrs, dueAt: new Date(card.dueAt) },
          {
            weight,
            rating: Rating.Good,
            now,
            timeZone: cached.context.timezone,
            enableFuzz: false,
          },
        );
        return update !== undefined && update.dueAt >= cached.context.nextLocalDay;
      })
    ) {
      covered.add(dueConceptId);
    }
  }
  return covered;
}

function activityDueCoverage(
  activity: SimActivity,
  state: SchedulerState,
  content: ContentIndex,
  now: Date,
): Set<string> {
  const covered = new Set<string>();
  if (activity.status === 'completed' || activity.status === 'skipped') return covered;
  const dueConceptIds = new Set(
    state.cards
      .filter((card) => isDueToday(card.dueAt, now, state.timezone ?? 'UTC'))
      .map((card) => card.conceptId),
  );
  const taskConceptIds = new Set([
    ...(activity.conceptId ? [activity.conceptId] : []),
    ...(activity.exerciseIds ?? []).flatMap((exerciseId) => {
      const conceptId = content.exercisesById.get(exerciseId)?.concept;
      return conceptId ? [conceptId] : [];
    }),
  ]);
  for (const conceptId of taskConceptIds) {
    for (const dueConceptId of dueTopicsCoveredByForAudit(conceptId, state, content, now)) {
      covered.add(dueConceptId);
    }
    if (activity.kind === 'review' && dueConceptIds.has(conceptId)) covered.add(conceptId);
  }
  if (activity.kind === 'review') {
    for (const topic of activity.reviewTopics ?? []) {
      if (dueConceptIds.has(topic.conceptId)) covered.add(topic.conceptId);
    }
  }
  for (const topic of activity.reviewTopics ?? []) {
    if (dueConceptIds.has(topic.conceptId)) covered.add(topic.conceptId);
  }
  return covered;
}

function dueCardKey(card: { conceptId: string; dimension: string }) {
  return `${card.conceptId}/${card.dimension}`;
}

function activityDueCardCoverage(
  activity: SimActivity,
  state: SchedulerState,
  content: ContentIndex,
  now: Date,
): Set<string> {
  const covered = new Set<string>();
  if (activity.status === 'completed' || activity.status === 'skipped') return covered;
  const dueCards = state.cards.filter((card) =>
    isDueToday(card.dueAt, now, state.timezone ?? 'UTC'),
  );
  const taskConceptIds = new Set([
    ...(activity.conceptId ? [activity.conceptId] : []),
    ...(activity.exerciseIds ?? []).flatMap((exerciseId) => {
      const conceptId = content.exercisesById.get(exerciseId)?.concept;
      return conceptId ? [conceptId] : [];
    }),
  ]);
  const implicitlyCovered = new Set(
    [...taskConceptIds].flatMap((conceptId) => [
      ...dueTopicsCoveredByForAudit(conceptId, state, content, now),
    ]),
  );
  const explicitlyReviewedDimensions = new Set(
    (activity.exerciseIds ?? []).flatMap((exerciseId) => {
      const exercise = content.exercisesById.get(exerciseId);
      return exercise ? [`${exercise.concept}/${exercise.dimension}`] : [];
    }),
  );
  for (const card of dueCards) {
    if (
      implicitlyCovered.has(card.conceptId) ||
      (activity.kind === 'review' &&
        explicitlyReviewedDimensions.has(`${card.conceptId}/${card.dimension}`))
    ) {
      covered.add(dueCardKey(card));
    }
  }
  return covered;
}

function localDayOrdinal(date: Date, timeZone: string): number {
  return Date.parse(`${localDateKey(date, timeZone)}T00:00:00.000Z`) / 86_400_000;
}

function auditReviewPlanInvariants(
  runtime: ProfileRuntime,
  day: number,
  courseId: string,
  state: SchedulerState,
  content: ContentIndex,
  now: Date,
  budgetMinutes: number,
  activities: SimActivity[],
  reviewExplanations?: ReviewSelectionExplanation[],
  replan = false,
) {
  const explanations =
    reviewExplanations ??
    explainReviewSelection(state, content, now, budgetMinutes, new Set(), {
      focusConceptId: state.inProgressConceptId,
    });
  const dueConceptIds = new Set(
    state.cards
      .filter((card) => isDueToday(card.dueAt, now, state.timezone ?? 'UTC'))
      .map((card) => card.conceptId),
  );
  const openRemediationConceptIds = new Set(
    state.remediationFlags.flatMap((flag) =>
      flag.status !== 'resolved' && flag.targetPrereqId ? [flag.targetPrereqId] : [],
    ),
  );
  const reviewConceptIdsForActivity = (activity: SimActivity) => {
    const reviewTopics = (activity.reviewTopics ?? []).map(({ conceptId }) => conceptId);
    if (reviewTopics.length > 0) return [...new Set(reviewTopics)];
    if (activity.conceptId) return [activity.conceptId];
    return [
      ...new Set(
        (activity.exerciseIds ?? []).flatMap((exerciseId) => {
          const conceptId = content.exercisesById.get(exerciseId)?.concept;
          return conceptId ? [conceptId] : [];
        }),
      ),
    ];
  };
  const unfinished = activities.filter(
    (activity) => activity.status !== 'completed' && activity.status !== 'skipped',
  );
  const selectedPlanActivities = unfinished.filter(
    (activity) => !replan || activity.status === 'planned',
  );
  const selectedConceptsForActivity = (activity: SimActivity) =>
    selectedReviewConceptsForAudit(reviewConceptIdsForActivity(activity), explanations);
  const coverageByActivity = selectedPlanActivities.map((activity) =>
    activity.kind === 'review' && selectedConceptsForActivity(activity).length === 0
      ? new Set<string>()
      : activityDueCoverage(activity, state, content, now),
  );
  const allCovered = new Set(coverageByActivity.flatMap((coverage) => [...coverage]));
  const nonRemediationReviews = selectedPlanActivities.flatMap((activity) =>
    activity.kind === 'review'
      ? selectedConceptsForActivity(activity)
          .filter((conceptId) => !openRemediationConceptIds.has(conceptId))
          .map((conceptId) => ({ activity, conceptId }))
      : [],
  );
  const overdueDays = (conceptId: string, exerciseDimensions?: readonly string[]) =>
    reviewOverdueDaysForAudit(
      state.cards,
      conceptId,
      now,
      state.timezone ?? 'UTC',
      exerciseDimensions,
    );
  const budgetActivities = unfinished.filter(
    (activity) => !replan || activity.status === 'planned',
  );
  const unfinishedMinutes = budgetActivities.reduce(
    (total, activity) => total + activity.plannedMinutes,
    0,
  );
  const selectedReviewMinutes = budgetActivities
    .filter((activity) => activity.kind === 'review')
    .reduce((total, activity) => total + activity.plannedMinutes, 0);
  const reviewCap = explanations[0]?.reviewCap ?? Math.floor(budgetMinutes * 0.3);
  const remainingBudgetMinutes = Math.max(0, budgetMinutes - unfinishedMinutes);
  const remainingReviewCapMinutes = Math.max(0, reviewCap - selectedReviewMinutes);

  for (const explanation of explanations) {
    if (
      !dueConceptIds.has(explanation.conceptId) ||
      (explanation.result !== 'rejected:reviewMinuteCap' &&
        explanation.result !== 'rejected:budget') ||
      allCovered.has(explanation.conceptId)
    ) {
      continue;
    }
    const reviewMinutes = requireP17ReviewMinutes(
      explanation.conceptId,
      explanation.candidateMinutes,
    );
    const droppedOverdueDays = overdueDays(explanation.conceptId, explanation.exerciseDimensions);
    markChecked(runtime, 'P17');
    if (
      p17ReviewFitsRemaining(
        reviewMinutes,
        remainingBudgetMinutes,
        remainingReviewCapMinutes,
        droppedOverdueDays,
      )
    ) {
      addViolation(runtime, day, 'P17', explanation.conceptId, [], {
        courseId,
        conceptId: explanation.conceptId,
        details: `uncovered due review of ${reviewMinutes} adjusted minutes fits the ${remainingBudgetMinutes}-minute remaining budget and ${remainingReviewCapMinutes}-minute review cap`,
      });
    }

    if (nonRemediationReviews.length === 0) continue;
    markChecked(runtime, 'P16');
    for (const selected of nonRemediationReviews) {
      const selectedCoverage = activityDueCoverage(selected.activity, state, content, now);
      const selectedExplanation = explanations.find(
        (item) => item.conceptId === selected.conceptId,
      );
      const selectedReviewMinutes = requireP17ReviewMinutes(
        selected.conceptId,
        selectedExplanation?.candidateMinutes,
      );
      const selectedOverdueDays = Math.max(
        0,
        ...[...selectedCoverage].map((conceptId) =>
          overdueDays(
            conceptId,
            conceptId === selected.conceptId ? selectedExplanation?.exerciseDimensions : undefined,
          ),
        ),
      );
      if (
        p16HasOverduePrecedenceViolation(
          droppedOverdueDays,
          selectedOverdueDays,
          reviewMinutes,
          remainingBudgetMinutes,
          remainingReviewCapMinutes,
          selectedReviewMinutes,
        )
      ) {
        addViolation(runtime, day, 'P16', explanation.conceptId, [], {
          courseId,
          conceptId: explanation.conceptId,
          evidenceConceptIds: [selected.conceptId, ...selectedCoverage],
          details: `${explanation.conceptId} was ${droppedOverdueDays} local days overdue while ${selected.conceptId} was selected at ${selectedOverdueDays} days overdue`,
        });
      }
    }
  }

  const coveredBefore = new Set<string>();
  for (const activity of selectedPlanActivities) {
    if (
      activity.kind === 'learn' &&
      (!state.inProgressConceptId ||
        state.inProgressConceptId === activity.conceptId ||
        state.lessonRuns?.some(
          ({ conceptId, status }) => conceptId === activity.conceptId && status !== 'completed',
        ))
    ) {
      for (const conceptId of activityDueCoverage(activity, state, content, now)) {
        coveredBefore.add(conceptId);
      }
    }
  }
  const reviewConceptIds = selectedPlanActivities
    .filter(({ kind }) => kind === 'review')
    .flatMap(reviewConceptIdsForActivity);
  for (const conceptId of selectedReviewConceptsForAudit(reviewConceptIds, explanations)) {
    markChecked(runtime, 'P19');
    const topicCoverage = new Set(dueTopicsCoveredByForAudit(conceptId, state, content, now));
    if (dueConceptIds.has(conceptId)) topicCoverage.add(conceptId);
    const newlyCovered = [...topicCoverage].filter(
      (dueConceptId) => !coveredBefore.has(dueConceptId),
    ).length;
    if (
      p19HasEarlyReviewViolation(
        dueConceptIds.has(conceptId),
        newlyCovered,
        openRemediationConceptIds.has(conceptId),
      )
    ) {
      addViolation(runtime, day, 'P19', conceptId, [], {
        courseId,
        conceptId,
        evidenceConceptIds: [...topicCoverage],
        details: `non-due review covered only ${newlyCovered} uncovered due topics`,
      });
    }
    for (const dueConceptId of topicCoverage) coveredBefore.add(dueConceptId);
  }
}

function checkLessonReadiness(
  runtime: ProfileRuntime,
  day: number,
  courseId: string | undefined,
  conceptIds: readonly string[],
  progress: LearnerProgress,
  content: ContentIndex,
) {
  for (const conceptId of new Set(conceptIds)) {
    if (!content.conceptsById.has(conceptId)) continue;
    const missing = hardAncestorClosure([conceptId], content, false).filter(
      (ancestorId) => !isDone(ancestorId, progress, content),
    );
    if (missing.length > 0) {
      addViolation(runtime, day, 'P1', conceptId, missing, {
        ...(courseId ? { courseId } : {}),
        conceptId,
      });
    }
  }
}

function checkProjectReadiness(
  runtime: ProfileRuntime,
  day: number,
  projectId: string,
  courseId: string | undefined,
  progress: Pick<LearnerProgress, 'masteryByKey' | 'lessonRuns'>,
  content: ContentIndex,
) {
  const project = content.projectsById.get(projectId);
  if (!project) return;
  const prerequisites = project.prereqs;
  const missing = hardAncestorClosure(prerequisites, content, true).filter(
    (conceptId) => !isDone(conceptId, progress, content),
  );
  if (missing.length > 0) {
    addViolation(runtime, day, 'P2', projectId, missing, {
      ...(courseId ? { courseId } : {}),
      projectId,
    });
  }
}

function auditCoursePage(
  runtime: ProfileRuntime,
  day: number,
  courseId: string,
  page: CoursePayload,
  progress: LearnerProgress,
  content: ContentIndex,
) {
  for (const topic of coursePageTopics(page)) {
    const missing = hardAncestorClosure([topic.conceptId], content, false).filter(
      (ancestorId) => !isDone(ancestorId, progress, content),
    );
    if (topic.status === 'not_started' && missing.length > 0) {
      addViolation(runtime, day, 'P3', topic.conceptId, missing, {
        courseId,
        conceptId: topic.conceptId,
        details: 'not_started_without_locked_status',
      });
    }
    if (topic.status === 'locked' && missing.length === 0) {
      addViolation(runtime, day, 'P3', topic.conceptId, [], {
        courseId,
        conceptId: topic.conceptId,
        details: 'locked_without_unmet_hard_ancestor',
      });
    }
  }
  for (const unit of page.units) {
    if (unit.project?.available) {
      offerProject(runtime, day, courseId, unit.project.id);
    }
  }
}

async function choiceIsStartable(
  api: SimulatedApi,
  now: Date,
  sessionKind: TodayPayload['sessionKind'],
  conceptId: string,
): Promise<boolean> {
  const result = await api.call('POST', '/sessions', now, {
    kind: sessionKind,
    focusConceptId: conceptId,
  });
  if (!result.ok) {
    if (result.status === 409) return false;
    throw new Error(
      `Focused session for ${conceptId} failed (${result.status}): ${JSON.stringify(result.data)}`,
    );
  }
  const sessionId = text(object(result.data).id);
  if (!sessionId) throw new Error(`Focused session for ${conceptId} returned no id`);
  await api.require('POST', `/sessions/${sessionId}/end`, now);
  return true;
}

async function auditHome(
  api: SimulatedApi,
  now: Date,
  runtime: ProfileRuntime,
  day: number,
  courseId: string | undefined,
  today: TodayPayload,
  learn: LearnPayload,
  progress: LearnerProgress,
  content: ContentIndex,
) {
  runtime.activeBehaviors.B3PartialExplain = false;
  runtime.violationEvidenceContext = {
    ...runtime.violationEvidenceContext,
    mastery: [...progress.masteryByKey].map(([key, record]) => {
      const separator = key.lastIndexOf(':');
      return {
        conceptId: key.slice(0, separator),
        dimension: key.slice(separator + 1),
        state: record.state,
        inferred: record.inferred,
      };
    }),
  };
  const planActivities = today.plan.activities as unknown as Array<{
    kind: string;
    conceptId?: string | null;
    projectId?: string;
  }>;
  const plannedLessons = planActivities
    .filter((activity) => activity.kind === 'learn' && activity.conceptId)
    .map((activity) => activity.conceptId as string);
  const taskLessons = learn.tasks
    .filter((task) => task.conceptId && ['Lesson', 'Practice', 'Quiz'].includes(task.label))
    .map((task) => task.conceptId as string);
  for (const conceptId of new Set([...plannedLessons, ...taskLessons])) {
    const run = progress.lessonRuns.find((candidate) => candidate.conceptId === conceptId);
    const hasOpenFlag = progress.remediationFlags.some((flag) => flag.conceptId === conceptId);
    const retryTooSoon = Boolean(run?.retryAfter && run.retryAfter > now);
    if (run?.status === 'needs_retry' && (retryTooSoon || hasOpenFlag)) {
      addViolation(runtime, day, 'P8', conceptId, [], {
        ...(courseId ? { courseId } : {}),
        conceptId,
        details: retryTooSoon
          ? 'needs_retry lesson offered before retry_after'
          : 'needs_retry lesson offered with open remediation flags',
      });
    }
  }
  for (const choice of learn.choices) {
    const missing = hardAncestorClosure([choice.conceptId], content, false).filter(
      (ancestorId) => !isDone(ancestorId, progress, content),
    );
    if (missing.length === 0) continue;
    const cacheKey = `${now.toISOString()}|${today.sessionKind}|${choice.conceptId}|${missing.join(',')}`;
    let startable = runtime.choiceStartability.get(cacheKey);
    if (startable === undefined) {
      startable = await choiceIsStartable(api, now, today.sessionKind, choice.conceptId);
      runtime.choiceStartability.set(cacheKey, startable);
    }
    if (!startable) continue;
    runtime.violationEvidenceContext = {
      ...runtime.violationEvidenceContext,
      behaviors: {
        ...runtime.violationEvidenceContext.behaviors,
        B2FocusConceptId: choice.conceptId,
      },
    };
    addViolation(runtime, day, 'P1', choice.conceptId, missing, {
      ...(courseId ? { courseId } : {}),
      conceptId: choice.conceptId,
      startable,
      details: 'listed as a Home lesson choice',
    });
  }
  for (const activity of planActivities) {
    if (activity.projectId) {
      if (courseId) offerProject(runtime, day, courseId, activity.projectId);
    }
  }
  for (const task of learn.tasks) {
    if (task.label === 'Project' && content.projectsById.has(task.id)) {
      if (courseId) offerProject(runtime, day, courseId, task.id);
    }
  }
  const nextProject = object(object(learn.upNext).project);
  const projectId = text(nextProject.projectId) ?? text(nextProject.id);
  if (projectId) {
    if (courseId) offerProject(runtime, day, courseId, projectId);
  }
}

async function auditSessionActivity(
  api: SimulatedApi,
  runtime: ProfileRuntime,
  now: Date,
  day: number,
  courseId: string,
  sessionId: string,
  activity: SimActivity,
  progress: LearnerProgress,
  state: SchedulerState,
  content: ContentIndex,
) {
  if (activity.kind === 'lab') {
    const session = await api.require<SessionPayload>('GET', `/sessions/${sessionId}`, now);
    if (!session.activities.some(({ id }) => id === activity.id)) return false;
  }
  runtime.activeBehaviors.B3PartialExplain = false;
  runtime.violationEvidenceContext = {
    ...runtime.violationEvidenceContext,
    beforeCards: schedulerCardEvidence(state, now),
    afterCards: [],
    activityLogs: [],
    mastery: [...progress.masteryByKey].map(([key, record]) => {
      const separator = key.lastIndexOf(':');
      return {
        conceptId: key.slice(0, separator),
        dimension: key.slice(separator + 1),
        state: record.state,
        inferred: record.inferred,
      };
    }),
    lessonRuns: progress.lessonRuns.map((run) => ({
      conceptId: run.conceptId,
      status: run.status,
      ...(run.retryAfter ? { retryAfter: run.retryAfter.toISOString() } : {}),
    })),
  };
  if (activity.kind === 'learn' && activity.conceptId) {
    checkLessonReadiness(runtime, day, courseId, [activity.conceptId], progress, content);
  }
  if (activity.projectId) {
    checkProjectReadiness(runtime, day, activity.projectId, courseId, progress, content);
  }
  return true;
}

function profileAccuracy(
  profile: SimulationProfile,
  conceptId: string,
  day: number,
  lastPracticed: ReadonlyMap<string, number>,
): number {
  if (profile === 'diligent' || profile === 'graph-change') return 1;
  if (profile === 'struggling') return 0.6;
  if (profile === 'forgetful') {
    const lastDay = lastPracticed.get(conceptId);
    const daysSince = lastDay === undefined ? 0 : Math.max(0, day - lastDay);
    return Math.max(0.4, 0.95 * 0.97 ** daysSince);
  }
  return 0.85;
}

function weakPrereqsForProfile(profile: SimulationProfile): string[] {
  return profile === 'gap' ? ['logistic-regression'] : [];
}

function answerForProfile(
  content: ContentIndex,
  exerciseId: string,
  seed: number,
  correct: boolean,
  partialExplain = false,
): unknown {
  const exercise = exerciseFor(content, exerciseId, seed);
  const answer = correct
    ? answerFor(content, exerciseId, seed)
    : wrongAnswerFor(content, exerciseId, seed);
  if (exercise.type !== 'explain') return answer;
  const answerObject = object(answer);
  return {
    text: text(answerObject.text) ?? 'A correct explanation.',
    metCriteria: correct
      ? exercise.rubric
          .slice(0, partialExplain ? exercise.rubric.length - 1 : undefined)
          .map((item) => item.id)
      : [],
  };
}

function wantsCorrect(
  runtime: ProfileRuntime,
  conceptId: string,
  day: number,
  activityId: string,
  exerciseId: string,
): boolean {
  const activityKey =
    runtime.activityKeyById.get(activityId) ?? `day:${day}|unmapped-activity:${exerciseId}`;
  const attemptKey = `${activityKey}|${exerciseId}`;
  const attempt = (runtime.decisionAttempts.get(attemptKey) ?? 0) + 1;
  runtime.decisionAttempts.set(attemptKey, attempt);
  const random = decisionRandom(runtime.profile, day, activityKey, exerciseId, attempt);
  const accuracy = profileAccuracy(runtime.profile, conceptId, day, runtime.lastPracticed);
  return random < accuracy;
}

function recordOutcome(runtime: ProfileRuntime, conceptId: string, day: number, correct: number) {
  runtime.answered += 1;
  if (correct < 1) runtime.wrongAnswers += 1;
  runtime.lastPracticed.set(conceptId, day);
}

async function fetchCourseCatalog(api: SimulatedApi, now: Date): Promise<CourseCatalogPayload> {
  return api.require<CourseCatalogPayload>('GET', '/courses', now);
}

async function fetchCoursePage(
  api: SimulatedApi,
  now: Date,
  courseId: string,
): Promise<CoursePayload> {
  return api.require<CoursePayload>('GET', `/courses/${encodeURIComponent(courseId)}`, now);
}

async function startCourse(
  api: SimulatedApi,
  content: ContentIndex,
  runtime: ProfileRuntime,
  courseId: string,
  now: Date,
  day: number,
): Promise<void> {
  await api.require('PUT', '/course/active', now, { courseId });
  const overplaced = runtime.profile === 'overplaced';
  if (runtime.profile !== 'placement' && !overplaced) {
    await api.require('POST', `/courses/${courseId}/start`, now, { method: 'beginning' });
    return;
  }
  const placement = object(await api.require('POST', '/placement', now, { courseId }));
  const placementId = text(placement.id);
  if (!placementId) throw new Error('Placement start did not return a run id');
  const course = content.coursesById.get(courseId);
  const topics = [...new Set(course?.units.flatMap((unit) => unit.concepts) ?? [])];
  const knownTopics = new Set(topics.slice(0, Math.ceil(topics.length / 3)));
  const guessedTopics = new Set(
    overplaced ? topics.slice(knownTopics.size, Math.ceil((topics.length * 2) / 3)) : [],
  );
  for (const conceptId of knownTopics) runtime.placement.trulyKnown.add(conceptId);
  for (let step = 0; step < 64; step += 1) {
    const next = object(await api.require('GET', `/placement/${placementId}/next`, now));
    const exercise = object(next.exercise);
    const exerciseId = text(exercise.id);
    if (!exerciseId) break;
    const conceptId = text(exercise.concept) ?? text(next.conceptId) ?? '';
    const guessed = guessedTopics.has(conceptId);
    const know = knownTopics.has(conceptId) || guessed;
    const targetSeconds = content.exercisesById.get(exerciseId)?.target_seconds ?? 90;
    const body = know
      ? {
          exerciseId,
          answer: answerForProfile(content, exerciseId, 0, true),
          ...(overplaced ? { durationMs: guessed ? targetSeconds * 3_000 : 5_000 } : {}),
        }
      : { exerciseId, dontKnow: true };
    const result = object(await api.require('POST', `/placement/${placementId}/answer`, now, body));
    recordOutcome(runtime, conceptId, day, know ? numeric(result.correct, 1) : 0);
    if (result.complete === true || result.completed === true) break;
  }
  await api.require('GET', `/placement/${placementId}/results`, now);
  if (overplaced && api.userId) {
    await recordOverplacement(api.db, api.userId, runtime.placement);
  }
}

function newTopicsCompleted(before: CoursePayload, after: CoursePayload): number {
  const completedBefore = new Set(
    coursePageTopics(before)
      .filter((topic) => topic.status === 'complete')
      .map((topic) => topic.conceptId),
  );
  return coursePageTopics(after).filter(
    (topic) => topic.status === 'complete' && !completedBefore.has(topic.conceptId),
  ).length;
}

async function auditP4(
  runtime: ProfileRuntime,
  day: number,
  courseId: string,
  conceptId: string,
  progress: LearnerProgress,
  content: ContentIndex,
) {
  if (!questionWasLearned(conceptId, progress, content)) {
    addViolation(runtime, day, 'P4', conceptId, [conceptId], {
      courseId,
      conceptId,
    });
  }
}

async function reviewCardAudit(
  runtime: ProfileRuntime,
  db: Database,
  userId: string,
  now: Date,
  day: number,
  timeZone: string,
  reportedCards: Set<string>,
) {
  const cards = await db
    .select()
    .from(reviewCards)
    .where(eq(reviewCards.userId, userId))
    .orderBy(asc(reviewCards.conceptId), asc(reviewCards.dimension), asc(reviewCards.id));
  const today = localDate(now, timeZone);
  for (const card of cards) {
    const dueDate = localDate(card.dueAt, timeZone);
    const overdueDays =
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86_400_000;
    const explanation = runtime.violationEvidenceContext.schedulerExplanations.find(
      (item) => item.conceptId === card.conceptId,
    );
    if (
      overdueDays > 7 &&
      explanation?.result.startsWith('rejected:') &&
      typeof explanation.candidateMinutes === 'number' &&
      p6HasFeasibleOverdueReview(
        overdueDays,
        explanation.candidateMinutes,
        Math.max(0, explanation.budget - explanation.usedMinutes),
        Math.max(0, explanation.reviewCap - explanation.reviewMinutes),
      ) &&
      !reportedCards.has(card.id)
    ) {
      reportedCards.add(card.id);
      addViolation(runtime, day, 'P6', card.conceptId, [], {
        conceptId: card.conceptId,
        details: `review card ${card.conceptId}/${card.dimension} is ${overdueDays} days overdue and its ${explanation.candidateMinutes}-minute review fits remaining capacity`,
      });
    }
  }
}

async function missedQuizPointIds(db: Database, runId: string): Promise<string[]> {
  const quizAttempts = await db
    .select()
    .from(lessonQuizAttempts)
    .where(eq(lessonQuizAttempts.runId, runId))
    .orderBy(lessonQuizAttempts.attemptNo);
  const lastAttempt = quizAttempts.at(-1);
  if (lastAttempt?.passed !== false || !lastAttempt?.submittedAt) return [];
  const items = await db
    .select()
    .from(lessonQuizItems)
    .where(eq(lessonQuizItems.quizAttemptId, lastAttempt.id))
    .orderBy(asc(lessonQuizItems.position), asc(lessonQuizItems.id));
  return [
    ...new Set(
      items
        .filter((item) => item.correct !== null && item.correct < 1)
        .map((item) => item.knowledgePointId),
    ),
  ];
}

function offerProject(runtime: ProfileRuntime, day: number, courseId: string, projectId: string) {
  const key = `${day}|${courseId}|${projectId}`;
  if (runtime.offeredProjectKeys.has(key)) return;
  runtime.offeredProjectKeys.add(key);
  runtime.report.projectsOffered.push({ day, courseId, projectId });
}

async function answerLessonProblem(
  api: SimulatedApi,
  content: ContentIndex,
  runtime: ProfileRuntime,
  now: Date,
  day: number,
  conceptId: string,
  activityId: string,
  runPath: string,
  pending: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const problemId = text(pending.id);
  const exerciseId = text(pending.exerciseId) ?? text(object(pending.exercise).id);
  if (!problemId || !exerciseId) throw new Error(`Missing lesson problem for ${conceptId}`);
  const problemConceptId = content.exercisesById.get(exerciseId)?.concept ?? conceptId;
  const pointId = text(pending.knowledgePointId);
  const weakPoint = Boolean(
    pointId &&
      keyPrereqsForPoint(content, conceptId, pointId).some(
        (prereqId) =>
          (runtime.weakPrereqs.includes(prereqId) &&
            !runtime.completedRemedialReviews.has(prereqId)) ||
          isOverplacedGap(runtime.placement, prereqId),
      ),
  );
  const intendedCorrect =
    !weakPoint && wantsCorrect(runtime, problemConceptId, day, activityId, exerciseId);
  const answer = answerForProfile(content, exerciseId, numeric(pending.seed), intendedCorrect);
  const response = await api.call('POST', `${runPath}/answer`, now, {
    problemId,
    activityId,
    answer,
    durationMs: 5_000,
  });
  if (!response.ok) {
    throw new Error(
      `POST ${runPath}/answer failed (${response.status}) for ${exerciseId}: ${JSON.stringify(response.data)}`,
    );
  }
  const result = object(response.data);
  recordOutcome(runtime, problemConceptId, day, numeric(result.correct, intendedCorrect ? 1 : 0));
  const run = object(result.state);
  if (run.status === 'needs_retry') {
    const halted = object(run.halted);
    const haltedPointId = text(halted.pointId);
    const haltedIndex = numeric(halted.index, -1);
    const previousIndex = runtime.lastHaltedPointIndex.get(conceptId);
    const targetPrereqIds = haltedPointId
      ? keyPrereqsForPoint(content, conceptId, haltedPointId)
      : [];
    const noProgress = previousIndex !== undefined && haltedIndex <= previousIndex;
    if (haltedPointId) {
      runtime.haltEvents.push({ day, conceptId, pointId: haltedPointId, noProgress });
    }
    runtime.awaitingRetryStart.add(conceptId);
    if (noProgress && targetPrereqIds.length > 0) {
      runtime.noProgressHalts.set(conceptId, {
        day,
        targetPrereqIds,
        reviewed: false,
      });
    }
    for (const flag of list(object(run.retry).reviewFirst)) {
      const prerequisiteId = text(object(flag).id);
      if (!prerequisiteId) continue;
      const key = `${conceptId}|${prerequisiteId}`;
      if (runtime.openFlagKeys.has(key)) continue;
      runtime.openFlagKeys.add(key);
      runtime.remediationFlagEvents.push({ day, conceptId, prerequisiteId });
    }
    runtime.lastHaltedPointIndex.set(conceptId, haltedIndex);
  }
  return run;
}

async function finishLessonSteps(
  api: SimulatedApi,
  content: ContentIndex,
  runtime: ProfileRuntime,
  now: Date,
  day: number,
  conceptId: string,
  activityId: string,
): Promise<Record<string, unknown>> {
  const runPath = `/lessons/${conceptId}/run`;
  const started = object(await api.require('POST', runPath, now, { activityId }));
  let run = object(started.run);
  if (runtime.awaitingRetryStart.delete(conceptId)) {
    runtime.retryEvents.push({ day, conceptId });
    runtime.retriedConcepts.add(conceptId);
  }
  for (let turn = 0; turn < 300; turn += 1) {
    const status = text(run.status);
    if (status === 'quiz' || status === 'completed' || status === 'needs_retry') return run;
    let pending = object(run.pendingProblem ?? run.pendingPracticeProblem);
    if (!text(pending.id)) {
      const refreshed = await api.call('POST', runPath, now, { activityId });
      if (!refreshed.ok) {
        if (status === 'quiz' || status === 'completed') return run;
        throw new Error(
          `POST ${runPath} failed (${refreshed.status}): ${JSON.stringify(refreshed.data)}`,
        );
      }
      run = object(object(refreshed.data).run);
      pending = object(run.pendingProblem ?? run.pendingPracticeProblem);
      if (!text(pending.id)) {
        if (run.status === 'quiz' || run.status === 'completed') return run;
        break;
      }
    }
    run = await answerLessonProblem(
      api,
      content,
      runtime,
      now,
      day,
      conceptId,
      activityId,
      runPath,
      pending,
    );
  }
  return run;
}

async function completeQuizWarmup(
  api: SimulatedApi,
  db: Database,
  content: ContentIndex,
  runtime: ProfileRuntime,
  now: Date,
  day: number,
  conceptId: string,
  activityId: string,
  runId: string,
) {
  const missedPointIds = await missedQuizPointIds(db, runId);
  let answerOffsetSeconds = 0;
  for (const pointId of missedPointIds) {
    for (let practiceNo = 0; practiceNo < 4; practiceNo += 1) {
      const result = await api.call('POST', `/lessons/${conceptId}/run/practice`, now, {
        pointId,
        activityId,
        warmup: true,
      });
      if (!result.ok) break;
      const run = object(object(result.data).run);
      const pending = object(run.pendingPracticeProblem);
      if (!text(pending.id)) break;
      answerOffsetSeconds += 1;
      await answerLessonProblem(
        api,
        content,
        runtime,
        new Date(now.getTime() + answerOffsetSeconds * 1_000),
        day,
        conceptId,
        activityId,
        `/lessons/${conceptId}/run`,
        pending,
      );
    }
  }
}

async function finishLessonQuiz(
  api: SimulatedApi,
  db: Database,
  content: ContentIndex,
  runtime: ProfileRuntime,
  now: Date,
  day: number,
  courseId: string,
  conceptId: string,
  activityId: string,
) {
  const quizPath = `/lessons/${conceptId}/quiz`;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const started = await api.call('POST', `${quizPath}/start`, now, { activityId });
    if (!started.ok) {
      if (started.status === 409) {
        if (attempt >= 9) return false;
        const [lessonRun] = await db
          .select({ id: lessonRuns.id })
          .from(lessonRuns)
          .where(and(eq(lessonRuns.userId, api.userId ?? ''), eq(lessonRuns.conceptId, conceptId)))
          .orderBy(desc(lessonRuns.updatedAt), desc(lessonRuns.id))
          .limit(1);
        const runId = lessonRun?.id;
        if (runId) {
          await completeQuizWarmup(
            api,
            db,
            content,
            runtime,
            now,
            day,
            conceptId,
            activityId,
            runId,
          );
          continue;
        }
        return false;
      }
      throw new Error(
        `POST ${quizPath}/start failed (${started.status}): ${JSON.stringify(started.data)}`,
      );
    }
    const run = object(object(started.data).run);
    const current = object(object(run.quiz).current);
    const items = list(current.items).map(object);
    const progress = await readProgress(db, api.userId ?? '');
    for (const item of items) {
      if (item.answered === true) continue;
      const itemId = text(item.id);
      const exercise = object(item.exercise);
      const exerciseId = text(exercise.id);
      if (!itemId || !exerciseId) continue;
      const [stored] = await db
        .select({
          seed: lessonQuizItems.seed,
          exerciseId: lessonQuizItems.exerciseId,
        })
        .from(lessonQuizItems)
        .where(eq(lessonQuizItems.id, itemId))
        .limit(1);
      const seed = stored?.seed ?? 0;
      const questionConceptId = content.exercisesById.get(exerciseId)?.concept ?? conceptId;
      await auditP4(runtime, day, courseId, questionConceptId, progress, content);
      const intendedCorrect = wantsCorrect(runtime, questionConceptId, day, activityId, exerciseId);
      const answer = answerForProfile(content, exerciseId, seed, intendedCorrect);
      const response = await api.call('POST', `${quizPath}/answer`, now, {
        itemId,
        activityId,
        answer,
        durationMs: 5_000,
      });
      if (!response.ok) {
        throw new Error(
          `POST ${quizPath}/answer failed (${response.status}) for ${exerciseId}: ${JSON.stringify(response.data)}`,
        );
      }
      const [gradedItem] = await db
        .select({ correct: lessonQuizItems.correct })
        .from(lessonQuizItems)
        .where(eq(lessonQuizItems.id, itemId))
        .limit(1);
      recordOutcome(
        runtime,
        questionConceptId,
        day,
        numeric(gradedItem?.correct, intendedCorrect ? 1 : 0),
      );
    }
    const submitted = await api.call('POST', `${quizPath}/submit`, now, { activityId });
    if (!submitted.ok) {
      throw new Error(
        `POST ${quizPath}/submit failed (${submitted.status}): ${JSON.stringify(submitted.data)}`,
      );
    }
    const submittedRun = object(object(submitted.data).run);
    if (submittedRun.status === 'completed') return true;
  }
  return false;
}

async function completeActivity(
  api: SimulatedApi,
  now: Date,
  sessionId: string,
  activity: SimActivity,
  progress: Record<string, unknown> = {},
) {
  await api.require('POST', `/sessions/${sessionId}/activities/${activity.id}/progress`, now, {
    ...progress,
    complete: true,
  });
}

async function attemptExercise(
  api: SimulatedApi,
  content: ContentIndex,
  runtime: ProfileRuntime,
  now: Date,
  day: number,
  courseId: string,
  sessionId: string,
  activityId: string,
  exerciseId: string,
  mode: 'practice' | 'review' | 'assessment',
): Promise<number> {
  const conceptId = content.exercisesById.get(exerciseId)?.concept ?? courseId;
  if (mode === 'review') {
    const attemptIndex = runtime.reviewActivityAttemptIndex.get(activityId) ?? 0;
    runtime.reviewActivityAttemptIndex.set(activityId, attemptIndex + 1);
    const dimension = content.exercisesById.get(exerciseId)?.dimension;
    if (dimension) {
      const dimensionOrder = runtime.reviewActivityDimensionOrder.get(activityId) ?? new Map();
      dimensionOrder.set(`${conceptId}/${dimension}`, attemptIndex);
      runtime.reviewActivityDimensionOrder.set(activityId, dimensionOrder);
    }
  }
  const intendedCorrect =
    wantsCorrect(runtime, conceptId, day, activityId, exerciseId) &&
    !isOverplacedGap(runtime.placement, conceptId);
  const exercise = exerciseFor(content, exerciseId, 0);
  const activityKey =
    runtime.activityKeyById.get(activityId) ?? `day:${day}|unmapped-activity:${exerciseId}`;
  const attempt = runtime.decisionAttempts.get(`${activityKey}|${exerciseId}`) ?? 1;
  const partialExplain =
    runtime.profile !== 'diligent' &&
    intendedCorrect &&
    exercise.type === 'explain' &&
    exercise.rubric.length >= 2 &&
    decisionRandom(runtime.profile, day, activityKey, `${exerciseId}:partial-explain`, attempt) <
      0.3;
  runtime.activeBehaviors.B3PartialExplain ||= partialExplain;
  const answer = answerForProfile(content, exerciseId, 0, intendedCorrect, partialExplain);
  const response = await api.call('POST', '/attempts', now, {
    exerciseId,
    answer,
    mode,
    sessionId,
    activityId,
    durationMs: 5_000,
  });
  if (!response.ok) {
    throw new Error(`POST /attempts failed (${response.status}): ${JSON.stringify(response.data)}`);
  }
  const result = object(response.data);
  const correct = numeric(result.correct, intendedCorrect ? 1 : 0);
  recordOutcome(runtime, conceptId, day, correct);
  if (partialExplain && result.retryAllowed === true) {
    const followUp = await api.call('POST', '/attempts', now, {
      exerciseId,
      answer: answerForProfile(content, exerciseId, 0, true),
      mode,
      sessionId,
      activityId,
      durationMs: 5_000,
    });
    if (!followUp.ok) {
      throw new Error(
        `POST /attempts follow-up failed (${followUp.status}): ${JSON.stringify(followUp.data)}`,
      );
    }
    const followUpCorrect = numeric(object(followUp.data).correct, 1);
    recordOutcome(runtime, conceptId, day, followUpCorrect);
    return followUpCorrect;
  }
  return correct;
}

function quizEvidence(
  runtime: ProfileRuntime,
  day: number,
  invariant: QuizInvariant,
  evidence: Record<string, unknown>,
  violation?: string,
) {
  runtime.report.quizEvidence ??= [];
  runtime.report.quizEvidence.push({ day, invariant, evidence });
  if (evidence.applicable !== false) markChecked(runtime, invariant);
  if (violation) {
    runtime.violationEvidenceContext.quiz = evidence;
    addViolation(runtime, day, invariant, 'mixed-quiz', [], { details: violation });
    delete runtime.violationEvidenceContext.quiz;
  }
}

async function auditQuizOffer(
  db: Database,
  runtime: ProfileRuntime,
  day: number,
  userId: string,
  offer: TodayPayload['quizOffer'],
  activities: SimActivity[],
  budget: number,
) {
  const openRuns = await db
    .select({ id: quizRuns.id })
    .from(quizRuns)
    .where(and(eq(quizRuns.userId, userId), isNull(quizRuns.finalizedAt)));
  const positions = activities.flatMap((activity, i) =>
    activity.kind === 'mixed_quiz' ? [i] : [],
  );
  const openActivities = await db
    .select({ id: sessionActivities.id })
    .from(sessionActivities)
    .innerJoin(studySessions, eq(studySessions.id, sessionActivities.sessionId))
    .where(
      and(
        eq(studySessions.userId, userId),
        eq(studySessions.status, 'active'),
        eq(sessionActivities.kind, 'mixed_quiz'),
        inArray(sessionActivities.status, ['planned', 'in_progress']),
      ),
    );
  const minutesFit = offer?.plannedMinutes != null && offer.plannedMinutes <= budget;
  const applicable = !!offer && (offer.xpBalance >= QUIZ_XP_INTERVAL || offer.active) && minutesFit;
  const evidence = {
    applicable,
    xpBalance: offer?.xpBalance,
    insideXpWindow:
      offer &&
      offer.xpBalance >= QUIZ_XP_INTERVAL &&
      offer.xpBalance <= QUIZ_XP_INTERVAL + QUIZ_XP_WINDOW,
    plannedMinutes: offer?.plannedMinutes,
    budget,
    pendingRuns: openRuns.length,
    pendingActivities: openActivities.length,
    offerPositions: positions,
    reason: applicable
      ? undefined
      : !offer || (!offer.active && offer.xpBalance < QUIZ_XP_INTERVAL)
        ? 'below threshold'
        : offer.plannedMinutes === null
          ? 'fewer than eight eligible topics'
          : 'quiz does not fit',
  };
  const violates =
    openRuns.length > 1 ||
    openActivities.length > 1 ||
    positions.length > 1 ||
    (applicable && positions[0] !== 0) ||
    (!applicable && positions.length > 0);
  quizEvidence(
    runtime,
    day,
    'P24',
    evidence,
    violates ? 'The session did not offer exactly one fitting quiz first when eligible' : undefined,
  );
}

async function processTimedQuiz(
  api: SimulatedApi,
  db: Database,
  content: ContentIndex,
  runtime: ProfileRuntime,
  now: Date,
  day: number,
  courseId: string,
  sessionId: string,
  activity: SimActivity,
) {
  const userId = api.userId ?? '';
  const original = await api.require<QuizPayload>('POST', '/quizzes/start', api.nextQuizTime(now), {
    sessionId,
    activityId: activity.id,
  });
  const runItems = (id: string) =>
    db.select().from(quizItems).where(eq(quizItems.runId, id)).orderBy(asc(quizItems.position));
  const firstItems = await runItems(original.id);
  const knownRows = await db
    .select({ topic: lessonRuns.conceptId })
    .from(lessonRuns)
    .where(and(eq(lessonRuns.userId, userId), eq(lessonRuns.status, 'completed')));
  const learned = new Set(knownRows.map(({ topic }) => topic));
  const history = await db
    .select({ question: quizItems.question, runId: quizItems.runId })
    .from(quizItems)
    .innerJoin(quizRuns, eq(quizRuns.id, quizItems.runId))
    .where(eq(quizRuns.userId, userId));
  const fingerprint = (question: (typeof firstItems)[number]['question']) =>
    question.exercise.prompt.trim().replace(/\s+/g, ' ');
  const encompassing = buildEncompassingIndex(content);
  const selectionEvidence = async (id: string, originalRun: boolean) => {
    const items = id === original.id ? firstItems : await runItems(id);
    const topics = items.map((item) => item.conceptId);
    const keys = items.map((item) => fingerprint(item.question));
    const historyKeys = new Set(
      history.filter(({ runId }) => id !== runId).map(({ question }) => fingerprint(question)),
    );
    const unknownTopics = topics.filter((topic) => !learned.has(topic));
    const repeatedQuestions = keys.filter(
      (key, index) => keys.indexOf(key) < index || historyKeys.has(key),
    );
    const overlap = topics.filter((topic) =>
      topics.some((other) => encompassing.ancestors(topic).has(other)),
    );
    const sameTopics =
      originalRun || topics.every((topic, i) => topic === firstItems[i]?.conceptId);
    quizEvidence(
      runtime,
      day,
      'P25',
      {
        topics,
        unknownTopics,
        repeatedQuestions,
        overlap,
        sameTopics,
        retake: !originalRun,
      },
      topics.length !== 8 ||
        new Set(topics).size !== 8 ||
        unknownTopics.length > 0 ||
        repeatedQuestions.length > 0 ||
        overlap.length > 0 ||
        !sameTopics
        ? 'Quiz contains an unlearned, overlapping or repeated question, or changed retake topics'
        : undefined,
    );
    return items;
  };
  const run = async (start: QuizPayload, items: typeof firstItems, timeout: boolean) => {
    const path = `/quizzes/${start.id}`;
    const startedAt = new Date(start.startedAt);
    let current = start;
    let received = startedAt;
    for (const item of items.slice(0, timeout ? 1 : items.length)) {
      if (!current.question) break;
      const exercise = item.question.exercise;
      const correct = wantsCorrect(runtime, exercise.concept, day, activity.id, exercise.id);
      const answer = correct
        ? answerFor(content, exercise.id, item.question.seed)
        : wrongAnswerFor(content, exercise.id, item.question.seed);
      current = await api.require<QuizPayload>('POST', `${path}/answer`, startedAt, {
        position: item.position,
        answer,
      });
      recordOutcome(runtime, exercise.concept, day, Number(correct));
      if (item.position === 0) current = await api.require<QuizPayload>('GET', path, startedAt);
    }
    const persisted = await runItems(start.id);
    const expectedScore = persisted.filter((item) => item.correct === true).length / items.length;
    let lateStatus: number | undefined;
    if (timeout && current.question) {
      const item = items[current.question.position];
      received = new Date(start.deadline);
      lateStatus = (
        await api.call('POST', `${path}/answer`, received, {
          position: item.position,
          answer: answerFor(content, item.question.exercise.id, item.question.seed),
        })
      ).status;
    }
    const finalizedAt = api.nextQuizTime(received);
    const result = await api.require<QuizPayload>('POST', `${path}/finalize`, finalizedAt);
    const repeated = await api.require<QuizPayload>('POST', `${path}/finalize`, finalizedAt);
    const awards = await db
      .select({ amount: xpEvents.amount })
      .from(xpEvents)
      .where(and(eq(xpEvents.userId, userId), eq(xpEvents.sourceKey, `mixed-quiz:${start.id}`)));
    const expectedXp = start.retake
      ? 0
      : Math.round(
          Math.ceil((Date.parse(start.deadline) - Date.parse(start.startedAt)) / 60_000) *
            expectedScore,
        );
    quizEvidence(
      runtime,
      day,
      'P27',
      {
        startedAt: start.startedAt,
        finalizedAt: finalizedAt.toISOString(),
        deadline: start.deadline,
        afterRefresh: current.deadline,
        expectedScore,
        score: result.result?.score,
        lateStatus,
        expectedXp,
        xp: result.result?.xpAwarded,
        awardCount: awards.length,
        retake: start.retake,
      },
      current.id !== start.id ||
        current.startedAt !== start.startedAt ||
        current.deadline !== start.deadline ||
        (timeout && lateStatus !== 409) ||
        result.result?.score !== expectedScore ||
        repeated.result?.score !== expectedScore ||
        result.result?.xpAwarded !== expectedXp ||
        awards.length !== Number(!start.retake)
        ? 'Refresh, timeout, final score, or idempotent award did not preserve the quiz'
        : undefined,
    );
    return { result, received: finalizedAt };
  };
  const items = await selectionEvidence(original.id, !original.retake);
  const { result, received } = await run(original, items, runtime.profile === 'scenario-quizzes');
  const missed = (await runItems(original.id))
    .filter((item) => item.correct !== true)
    .map((item) => item.conceptId);
  if (missed.length === 0 || original.retake) {
    return { lessons: 0, reviews: 0, reviewAttempts: 0 };
  }
  const path = `/quizzes/${original.id}`;
  const earlyRetake = await api.call('POST', `${path}/retake`, received);
  const dueCards = await db
    .select({ conceptId: reviewCards.conceptId, dueAt: reviewCards.dueAt })
    .from(reviewCards)
    .where(and(eq(reviewCards.userId, userId), inArray(reviewCards.conceptId, missed)));
  const dueNowTopics = missed.filter((topic) =>
    dueCards.some((card) => card.conceptId === topic && card.dueAt <= received),
  );
  const followUpAt = api.nextQuizTime(received);
  const followUps = await api.call('POST', `${path}/follow-ups`, followUpAt);
  let reviews = 0;
  let reviewAttempts = 0;
  if (followUps.ok) {
    const id = text(object(followUps.data).sessionId);
    if (!id) throw new Error('Follow-ups did not return a session id');
    const session = await api.require<{ activities: SimActivity[] }>(
      'GET',
      `/sessions/${id}`,
      followUpAt,
    );
    for (const review of session.activities) {
      const reviewAt = api.nextQuizTime(followUpAt);
      runtime.activityKeyById.set(review.id, `day:${day}|quiz-follow-up|${review.conceptId}`);
      const result = await processActivity(
        api,
        db,
        content,
        runtime,
        reviewAt,
        day,
        courseId,
        id,
        review,
      );
      reviews += result.reviews;
      reviewAttempts += result.reviewAttempts;
    }
    await api.require('POST', `/sessions/${id}/end`, api.nextQuizTime(followUpAt));
  }
  const after = await api.require<QuizPayload>('GET', path, api.nextQuizTime(followUpAt));
  const reviewed =
    after.result?.topics.filter((topic) => topic.reviewed).map((topic) => topic.conceptId) ?? [];
  const evidence = {
    missed,
    dueNowTopics,
    reviewed,
    earlyRetakeStatus: earlyRetake.status,
    listedTopics: result.result?.topics.map((topic) => topic.conceptId),
    eligibleAfterFollowUps: after.result?.retake.eligible,
  };
  quizEvidence(
    runtime,
    day,
    'P26',
    evidence,
    earlyRetake.status !== 409 ||
      !after.result?.retake.eligible ||
      missed.some((topic) => !reviewed.includes(topic) || !dueNowTopics.includes(topic))
      ? 'A missed topic lacked an immediate follow-up or the retake gate failed'
      : undefined,
  );
  if (after.result?.retake.eligible) {
    const retake = await api.require<QuizPayload>(
      'POST',
      `${path}/retake`,
      api.nextQuizTime(followUpAt),
    );
    const retakeItems = await selectionEvidence(retake.id, false);
    await run(retake, retakeItems, false);
  }
  return { lessons: 0, reviews, reviewAttempts };
}

async function processActivity(
  api: SimulatedApi,
  db: Database,
  content: ContentIndex,
  runtime: ProfileRuntime,
  now: Date,
  day: number,
  courseId: string,
  sessionId: string,
  activity: SimActivity,
): Promise<{ lessons: number; reviews: number; reviewAttempts: number }> {
  const exerciseIds = activity.exerciseIds ?? [];
  if (activity.kind === 'mixed_quiz') {
    return processTimedQuiz(api, db, content, runtime, now, day, courseId, sessionId, activity);
  }
  let reviewAttempts = 0;
  if (activity.kind === 'learn' && activity.conceptId) {
    const lesson = content.lessonsByConcept.get(activity.conceptId);
    if (lesson?.knowledge_points?.length) {
      const run = await finishLessonSteps(
        api,
        content,
        runtime,
        now,
        day,
        activity.conceptId,
        activity.id,
      );
      if (run.status === 'quiz') {
        await finishLessonQuiz(
          api,
          db,
          content,
          runtime,
          now,
          day,
          courseId,
          activity.conceptId,
          activity.id,
        );
      }
      const finalRun = await db
        .select({ status: lessonRuns.status })
        .from(lessonRuns)
        .where(
          and(
            eq(lessonRuns.userId, api.userId ?? ''),
            eq(lessonRuns.conceptId, activity.conceptId),
          ),
        )
        .orderBy(desc(lessonRuns.updatedAt), desc(lessonRuns.id))
        .limit(1);
      if (finalRun[0]?.status === 'completed') {
        runtime.placement.learned.add(activity.conceptId);
        await completeActivity(api, now, sessionId, activity, {
          lessonViewed: true,
          lessonRunnerContinued: true,
        });
        if (
          runtime.retriedConcepts.has(activity.conceptId) &&
          !runtime.completedAfterRetryConcepts.has(activity.conceptId)
        ) {
          runtime.completedAfterRetryConcepts.add(activity.conceptId);
          runtime.postRetryCompletionEvents.push({ day, conceptId: activity.conceptId });
        }
      }
    } else {
      for (const exerciseId of exerciseIds) {
        await attemptExercise(
          api,
          content,
          runtime,
          now,
          day,
          courseId,
          sessionId,
          activity.id,
          exerciseId,
          'practice',
        );
      }
      await completeActivity(api, now, sessionId, activity);
    }
    return { lessons: 1, reviews: 0, reviewAttempts: 0 };
  }
  if (activity.kind === 'review') {
    const progress = await readProgress(db, api.userId ?? '');
    const attemptedExerciseIds = new Set<string>();
    let pendingExerciseIds = exerciseIds;
    while (true) {
      for (const exerciseId of pendingExerciseIds) {
        if (attemptedExerciseIds.has(exerciseId)) continue;
        attemptedExerciseIds.add(exerciseId);
        const conceptId = content.exercisesById.get(exerciseId)?.concept;
        if (conceptId) await auditP4(runtime, day, courseId, conceptId, progress, content);
        await attemptExercise(
          api,
          content,
          runtime,
          now,
          day,
          courseId,
          sessionId,
          activity.id,
          exerciseId,
          'review',
        );
        reviewAttempts += 1;
      }
      const session = object(await api.require('GET', `/sessions/${sessionId}`, now));
      const currentActivity = list(session.activities)
        .map((item) => object(item))
        .find((item) => item.id === activity.id);
      if (!currentActivity) {
        throw new Error(`Review activity ${activity.id} disappeared from session ${sessionId}`);
      }
      pendingExerciseIds = list(currentActivity.exerciseIds).filter(
        (exerciseId): exerciseId is string => typeof exerciseId === 'string',
      );
      pendingExerciseIds = pendingExerciseIds.filter(
        (exerciseId) => !attemptedExerciseIds.has(exerciseId),
      );
      if (pendingExerciseIds.length === 0) break;
    }
    await completeActivity(api, now, sessionId, activity);
    const reviewedPrereqs = new Set<string>();
    for (const exerciseId of attemptedExerciseIds) {
      const prereqId = content.exercisesById.get(exerciseId)?.concept;
      if (!prereqId || reviewedPrereqs.has(prereqId)) continue;
      reviewedPrereqs.add(prereqId);
      const flaggedLessons = [
        ...new Set(
          progress.remediationFlags
            .filter((flag) => flag.targetPrereqId === prereqId)
            .map((flag) => flag.conceptId),
        ),
      ];
      if (flaggedLessons.length === 0) continue;
      runtime.completedRemedialReviews.add(prereqId);
      for (const flaggedLessonId of flaggedLessons) {
        runtime.openFlagKeys.delete(`${flaggedLessonId}|${prereqId}`);
        runtime.remedialReviewEvents.push({
          day,
          conceptId: flaggedLessonId,
          prerequisiteId: prereqId,
        });
      }
      for (const [flaggedLessonId, halt] of runtime.noProgressHalts) {
        if (
          halt.targetPrereqIds.length > 0 &&
          halt.targetPrereqIds.every(
            (targetPrereqId) => !runtime.openFlagKeys.has(`${flaggedLessonId}|${targetPrereqId}`),
          )
        ) {
          halt.reviewed = true;
        }
      }
    }
    return { lessons: 0, reviews: 1, reviewAttempts };
  }
  if (activity.projectId) {
    offerProject(runtime, day, courseId, activity.projectId);
  }
  if (activity.kind === 'paper') {
    const paperId = activity.paperId ?? activity.conceptId ?? '';
    if (paperId) runtime.report.papersRecorded.push({ day, courseId, paperId });
    if (paperId) {
      await api.require('PUT', `/papers/${paperId}/progress`, now, { lastPage: 1 });
    }
  } else {
    const mode = activity.kind === 'quick_check' ? 'assessment' : 'practice';
    for (const exerciseId of exerciseIds) {
      await attemptExercise(
        api,
        content,
        runtime,
        now,
        day,
        courseId,
        sessionId,
        activity.id,
        exerciseId,
        mode,
      );
    }
  }
  await completeActivity(api, now, sessionId, activity);
  return { lessons: 0, reviews: 0, reviewAttempts };
}

interface P11CardSnapshot {
  id: string;
  dueAt: Date;
  lastReviewAt: Date | null;
  fsrs: unknown;
}

interface P11ActivityLog {
  cardId: string;
  conceptId: string;
  dimension?: string;
  rating: string;
  previousLog?: { rating: string; createdAt: Date } | null;
}

interface P15PrerequisiteResetContext {
  hardPrerequisiteIdsByConcept: ReadonlyMap<string, readonly string[]>;
  completedReviewConceptIds: ReadonlySet<string>;
  coveredDimensionKeys: ReadonlySet<string>;
}

type P11DescendantAssessment =
  | { kind: 'explicit' }
  | { kind: 'ambiguous' }
  | { kind: 'checked'; fiReChanged: boolean; violates: boolean };

export function auditP11DescendantCard(
  report: Pick<ProfileSimulationReport, 'p11CheckedEvents' | 'p11AmbiguousEvents'>,
  descendantId: string,
  previous: P11CardSnapshot,
  card: P11CardSnapshot,
  activityLogs: readonly P11ActivityLog[],
  encompassing: Pick<EncompassingIndex, 'weight'>,
): P11DescendantAssessment {
  const lastReviewAtChanged =
    (previous.lastReviewAt?.getTime() ?? null) !== (card.lastReviewAt?.getTime() ?? null);
  if (lastReviewAtChanged || activityLogs.some(({ cardId }) => cardId === previous.id)) {
    return { kind: 'explicit' };
  }

  const minimumRatingByConcept = new Map<string, number>();
  for (const { conceptId, rating } of activityLogs) {
    const numericRating = Number(rating);
    const currentMinimum = minimumRatingByConcept.get(conceptId);
    minimumRatingByConcept.set(
      conceptId,
      currentMinimum === undefined ? numericRating : Math.min(currentMinimum, numericRating),
    );
  }
  const hasPositiveCredit = [...minimumRatingByConcept].some(
    ([conceptId, rating]) =>
      rating >= Rating.Hard && encompassing.weight(conceptId, descendantId) > 0,
  );
  if (hasPositiveCredit) {
    report.p11AmbiguousEvents += 1;
    return { kind: 'ambiguous' };
  }

  report.p11CheckedEvents += 1;
  const previousFsrs = previous.fsrs as { stability: number; difficulty: number };
  const currentFsrs = card.fsrs as { stability: number; difficulty: number };
  const fiReChanged =
    previous.dueAt.getTime() !== card.dueAt.getTime() ||
    previousFsrs.stability !== currentFsrs.stability ||
    previousFsrs.difficulty !== currentFsrs.difficulty;
  const dueAtMovedLater = card.dueAt.getTime() > previous.dueAt.getTime();
  const dueAtDidNotMoveEarlier = card.dueAt.getTime() >= previous.dueAt.getTime();
  return {
    kind: 'checked',
    fiReChanged,
    violates: dueAtMovedLater || (fiReChanged && dueAtDidNotMoveEarlier),
  };
}

interface P15CardSnapshot {
  id: string;
  conceptId: string;
  dimension?: string;
  dueAt: Date;
  lastReviewAt: Date | null;
  fsrs: unknown;
  suspendedAt?: Date | null;
}

function p15CardIdentity(card: P15CardSnapshot): string {
  return `${card.conceptId}/${card.dimension ?? 'unknown'}`;
}

type P15TraceEvent = ImplicitRepetitionTraceEvent & { activityOrder: number | null };

interface P15PrerequisiteResetEvidence {
  sourceCardId: string;
  sourceConceptId: string;
  sourceOrder: number;
  candidateCardIds: string[];
  eligibleCardIds: string[];
  selectedCardId: string | null;
}

function p15Comparable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(p15Comparable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, p15Comparable(item)]),
    );
  }
  return value;
}

function p15TraceState(card: {
  dueAt: Date;
  fsrs: Card;
  stability?: number;
  difficulty?: number;
}): string {
  return JSON.stringify(
    p15Comparable({
      dueAt: card.dueAt,
      stability: card.stability ?? card.fsrs.stability,
      difficulty: card.difficulty ?? card.fsrs.difficulty,
      fsrs: card.fsrs,
    }),
  );
}

export function auditP15Trace(
  beforeCards: readonly P15CardSnapshot[],
  afterCards: readonly P15CardSnapshot[],
  activityLogs: readonly P11ActivityLog[],
  trace: readonly P15TraceEvent[],
  encompassing: Pick<EncompassingIndex, 'weight' | 'ancestors' | 'descendants'>,
  now: Date,
  timeZone: string,
  activityKind: 'learn' | 'review',
  reviewLogOrder: ReadonlyMap<string, number> = new Map(),
  prerequisiteResetContext?: P15PrerequisiteResetContext,
  withdrawnConceptIds: ReadonlySet<string> = new Set(),
): {
  checked: number;
  violations: string[];
  prerequisiteResetEvidence: P15PrerequisiteResetEvidence[];
} {
  const minimumRatingByConcept = new Map<string, number>();
  for (const log of activityLogs) {
    minimumRatingByConcept.set(
      log.conceptId,
      Math.min(minimumRatingByConcept.get(log.conceptId) ?? Infinity, Number(log.rating)),
    );
  }
  const cardsById = new Map<string, P15CardSnapshot>();
  for (const card of [...beforeCards, ...afterCards]) cardsById.set(card.id, card);
  const beforeById = new Map(beforeCards.map((card) => [card.id, card]));
  const afterById = new Map(afterCards.map((card) => [card.id, card]));
  const violations: string[] = [];
  const pairCounts = new Map<string, number>();
  let checked = 0;

  for (const event of trace) {
    checked += 4;
    const pair = `${event.sourceConceptId}\u0000${event.targetCardId}`;
    const target = cardsById.get(event.targetCardId);
    const targetIdentity = target ? p15CardIdentity(target) : 'unknown target';
    pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
    if (pairCounts.get(pair) !== 1) {
      violations.push(`duplicate source/card pair ${event.sourceConceptId} -> ${targetIdentity}`);
    }

    const sourceRating = minimumRatingByConcept.get(event.sourceConceptId);
    if (sourceRating === undefined) {
      if (withdrawnConceptIds.has(event.sourceConceptId)) continue;
      violations.push(`trace source ${event.sourceConceptId} has no activity rating`);
    } else if (
      event.rating === Rating.Again
        ? sourceRating !== Rating.Again
        : event.rating < Rating.Hard || event.rating !== sourceRating
    ) {
      violations.push(
        `${event.sourceConceptId} -> ${targetIdentity}: trace rating ${event.rating} does not match activity minimum ${sourceRating}`,
      );
    }

    if (!target) {
      violations.push(
        `trace target for ${event.sourceConceptId} is absent from activity snapshots`,
      );
      continue;
    }
    if (
      event.before.stability !== event.before.fsrs.stability ||
      event.before.difficulty !== event.before.fsrs.difficulty
    ) {
      violations.push(`${p15CardIdentity(target)}: trace before-state is inconsistent`);
    }
    const expectedWeight =
      event.rating === Rating.Again
        ? encompassing.weight(target.conceptId, event.sourceConceptId)
        : encompassing.weight(event.sourceConceptId, target.conceptId);
    if (event.weight <= 0 || event.weight !== expectedWeight) {
      violations.push(
        `${event.sourceConceptId} -> ${p15CardIdentity(target)}: trace weight ${event.weight} does not match ${expectedWeight}`,
      );
    }

    const result = implicitRepetition(
      { dueAt: event.before.dueAt, fsrs: event.before.fsrs },
      { weight: event.weight, rating: event.rating, now, timeZone, enableFuzz: false },
    );
    const expectedAfter = result ?? event.before;
    if (
      event.applied !== (result !== undefined) ||
      p15TraceState(expectedAfter) !== p15TraceState(event.after)
    ) {
      violations.push(
        `${p15CardIdentity(target)}: trace after-state does not match implicitRepetition`,
      );
    }
  }

  for (const [sourceConceptId, rating] of minimumRatingByConcept) {
    if (activityKind === 'learn' && rating === Rating.Again) continue;
    if (rating !== Rating.Again && rating < Rating.Hard) continue;
    const targets =
      rating === Rating.Again
        ? encompassing.descendants(sourceConceptId)
        : encompassing.ancestors(sourceConceptId);
    for (const card of cardsById.values()) {
      if (!afterById.has(card.id) && withdrawnConceptIds.has(card.conceptId)) continue;
      const snapshot = beforeById.get(card.id) ?? card;
      if (!snapshot.fsrs || (snapshot.fsrs as Card).state === State.New) continue;
      const weight = targets.get(card.conceptId);
      if (weight === undefined || weight <= 0) continue;
      const result = implicitRepetition(
        { dueAt: snapshot.dueAt, fsrs: snapshot.fsrs as Card },
        { weight, rating: rating as Rating, now, timeZone, enableFuzz: false },
      );
      if (!result) continue;
      checked += 1;
      if (!pairCounts.has(`${sourceConceptId}\u0000${card.id}`)) {
        violations.push(
          `coverage missing ${sourceConceptId} -> ${p15CardIdentity(card)} with weight ${weight}`,
        );
      }
    }
  }

  const prerequisiteResetEvidence: P15PrerequisiteResetEvidence[] = [];
  const resetTouchedAfterTrace = new Set<string>();
  if (activityKind === 'review' && prerequisiteResetContext) {
    for (const log of activityLogs) {
      if (Number(log.rating) !== Rating.Again || log.previousLog?.rating !== String(Rating.Again)) {
        continue;
      }
      const sourceOrder = reviewLogOrder.get(log.cardId);
      if (sourceOrder === undefined) continue;
      const hardPrerequisiteIds =
        prerequisiteResetContext.hardPrerequisiteIdsByConcept.get(log.conceptId) ?? [];
      const candidates = [...beforeById.values()].filter(
        (card) => hardPrerequisiteIds.includes(card.conceptId) && !card.suspendedAt,
      );
      const eligible = candidates.filter((card) =>
        canBringPrerequisiteDueNow({
          lastReviewAt: card.lastReviewAt,
          now,
          timeZone,
          coveredByActivity:
            prerequisiteResetContext.completedReviewConceptIds.has(card.conceptId) ||
            prerequisiteResetContext.coveredDimensionKeys.has(
              `${card.conceptId}/${card.dimension ?? ''}`,
            ),
        }),
      );
      const eligibleStates = eligible.map((card) => {
        const latestTrace = [...trace]
          .reverse()
          .find(
            (event) =>
              event.targetCardId === card.id &&
              event.activityOrder !== null &&
              event.activityOrder <= sourceOrder,
          );
        return {
          ...card,
          dimension: card.dimension ?? '',
          dueAt: latestTrace?.after.dueAt ?? card.dueAt,
          fsrs: latestTrace?.after.fsrs ?? (card.fsrs as Card),
        };
      });
      const weakest = bringWeakestPrerequisiteCardDueNow(eligibleStates, now, false);
      prerequisiteResetEvidence.push({
        sourceCardId: log.cardId,
        sourceConceptId: log.conceptId,
        sourceOrder,
        candidateCardIds: candidates.map(({ id }) => id),
        eligibleCardIds: eligible.map(({ id }) => id),
        selectedCardId: weakest?.id ?? null,
      });
      if (!weakest) continue;

      const latestTrace = [...trace].reverse().find((event) => event.targetCardId === weakest.id);
      const actual = afterById.get(weakest.id);
      const before = beforeById.get(weakest.id);
      if (
        latestTrace &&
        latestTrace.activityOrder !== null &&
        sourceOrder >= latestTrace.activityOrder &&
        actual?.dueAt.getTime() === now.getTime() &&
        actual.fsrs &&
        new Date(String((actual.fsrs as Card).due)).getTime() === now.getTime() &&
        before?.lastReviewAt?.getTime() === actual.lastReviewAt?.getTime()
      ) {
        resetTouchedAfterTrace.add(weakest.id);
      }
    }
  }

  const lastTraceByCard = new Map<string, P15TraceEvent>();
  for (const event of trace) lastTraceByCard.set(event.targetCardId, event);
  for (const [cardId, lastTrace] of lastTraceByCard) {
    checked += 1;
    const actual = afterById.get(cardId);
    if (!actual) {
      const target = cardsById.get(cardId);
      if (target && withdrawnConceptIds.has(target.conceptId)) continue;
      violations.push(
        `${target ? p15CardIdentity(target) : 'unknown target'}: trace target is missing from final card state`,
      );
      continue;
    }
    const explicitReviewAfterTrace =
      lastTrace.activityOrder !== null &&
      (reviewLogOrder.get(cardId) ?? Number.NEGATIVE_INFINITY) > lastTrace.activityOrder;
    if (explicitReviewAfterTrace || resetTouchedAfterTrace.has(cardId)) continue;
    if (
      p15TraceState(lastTrace.after) !==
      p15TraceState({ dueAt: actual.dueAt, fsrs: actual.fsrs as Card })
    ) {
      violations.push(`${p15CardIdentity(actual)}: final state differs from the last trace result`);
    }
  }

  return { checked, violations, prerequisiteResetEvidence };
}

export function attributeActivityLogs<T extends { id: string }>(
  beforeIds: ReadonlySet<string>,
  afterLogs: readonly T[],
  checkedIds: Set<string>,
): T[] {
  const newLogs = afterLogs.filter(({ id }) => !beforeIds.has(id) && !checkedIds.has(id));
  for (const { id } of afterLogs) checkedIds.add(id);
  return newLogs;
}

/** The API skips planned work that a placement withdrawal no longer unlocks. */
async function activityWasSkipped(db: Database, activityId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: sessionActivities.status })
    .from(sessionActivities)
    .where(eq(sessionActivities.id, activityId))
    .limit(1);
  return row?.status === 'skipped';
}

async function processActivityWithMetrics(
  api: SimulatedApi,
  db: Database,
  content: ContentIndex,
  runtime: ProfileRuntime,
  now: Date,
  timeZone: string,
  day: number,
  courseId: string,
  sessionId: string,
  activity: SimActivity,
) {
  const userId = api.userId ?? '';
  const tracksCards = activity.kind === 'learn' || activity.kind === 'review';
  const readActivityLogs = () =>
    db
      .select({
        id: reviewLogs.id,
        cardId: reviewLogs.cardId,
        rating: reviewLogs.rating,
        conceptId: reviewCards.conceptId,
        dimension: reviewCards.dimension,
      })
      .from(reviewLogs)
      .innerJoin(reviewCards, eq(reviewLogs.cardId, reviewCards.id))
      .where(and(eq(reviewCards.userId, userId), eq(reviewLogs.createdAt, now)))
      .orderBy(
        asc(reviewLogs.createdAt),
        asc(reviewCards.conceptId),
        asc(reviewCards.dimension),
        asc(reviewLogs.rating),
        asc(reviewLogs.id),
      );
  const beforeSchedulerState = tracksCards
    ? await new LearnerRepository(db, userId).schedulerState(now, content)
    : undefined;
  const beforeCards = tracksCards
    ? await db
        .select()
        .from(reviewCards)
        .where(eq(reviewCards.userId, userId))
        .orderBy(asc(reviewCards.conceptId), asc(reviewCards.dimension), asc(reviewCards.id))
    : [];
  const previousLogsByCardId = new Map<string, { rating: string; createdAt: Date }>();
  const completedReviewConceptIds = new Set<string>();
  if (activity.kind === 'review') {
    const activityCardIds = beforeCards
      .filter((card) =>
        activity.exerciseIds.some((exerciseId) => {
          const exercise = content.exercisesById.get(exerciseId);
          return exercise?.concept === card.conceptId && exercise.dimension === card.dimension;
        }),
      )
      .map((card) => card.id);
    if (activityCardIds.length > 0) {
      const previousLogs = await db
        .select({
          cardId: reviewLogs.cardId,
          rating: reviewLogs.rating,
          createdAt: reviewLogs.createdAt,
        })
        .from(reviewLogs)
        .where(inArray(reviewLogs.cardId, activityCardIds))
        .orderBy(desc(reviewLogs.createdAt));
      for (const log of previousLogs) {
        if (!previousLogsByCardId.has(log.cardId)) {
          previousLogsByCardId.set(log.cardId, { rating: log.rating, createdAt: log.createdAt });
        }
      }
    }
    const priorSessionActivities = await db
      .select({
        id: sessionActivities.id,
        kind: sessionActivities.kind,
        status: sessionActivities.status,
        exerciseIds: sessionActivities.exerciseIds,
      })
      .from(sessionActivities)
      .where(eq(sessionActivities.sessionId, sessionId));
    for (const priorActivity of priorSessionActivities) {
      if (
        priorActivity.id !== activity.id &&
        priorActivity.kind === 'review' &&
        priorActivity.status === 'completed'
      ) {
        for (const exerciseId of priorActivity.exerciseIds) {
          const conceptId = content.exercisesById.get(exerciseId)?.concept;
          if (conceptId) completedReviewConceptIds.add(conceptId);
        }
      }
    }
  }
  const beforeLogIds = new Set(tracksCards ? (await readActivityLogs()).map(({ id }) => id) : []);
  runtime.activeBehaviors.B3PartialExplain = false;
  const implicitRepetitionTrace: P15TraceEvent[] = [];
  if (activity.kind === 'review') {
    runtime.reviewActivityAttemptIndex.set(activity.id, 0);
    runtime.reviewActivityDimensionOrder.set(activity.id, new Map());
  }
  setImplicitRepetitionTrace(
    tracksCards
      ? (event) =>
          implicitRepetitionTrace.push({
            ...event,
            activityOrder:
              activity.kind === 'review'
                ? Math.max(0, (runtime.reviewActivityAttemptIndex.get(activity.id) ?? 0) - 1)
                : null,
          })
      : undefined,
  );
  let result: Awaited<ReturnType<typeof processActivity>>;
  try {
    result = await processActivity(
      api,
      db,
      content,
      runtime,
      now,
      day,
      courseId,
      sessionId,
      activity,
    );
  } finally {
    setImplicitRepetitionTrace(undefined);
  }
  if (runtime.activeBehaviors.B3PartialExplain) {
    const dayPlans = [...(runtime.planEvidenceByDay.get(day) ?? [])];
    const activityKey = runtime.activityKeyById.get(activity.id);
    let planIndex = -1;
    for (let index = dayPlans.length - 1; index >= 0; index -= 1) {
      if (dayPlans[index].activities.some(({ activityId }) => activityId === activityKey)) {
        planIndex = index;
        break;
      }
    }
    if (planIndex >= 0) {
      const plan = dayPlans[planIndex];
      dayPlans[planIndex] = {
        ...plan,
        behaviors: { ...plan.behaviors, B3PartialExplain: true },
      };
      runtime.planEvidenceByDay.set(day, dayPlans);
    }
  }
  const afterCards = tracksCards
    ? await db
        .select()
        .from(reviewCards)
        .where(eq(reviewCards.userId, userId))
        .orderBy(asc(reviewCards.conceptId), asc(reviewCards.dimension), asc(reviewCards.id))
    : [];
  const activityLogs = tracksCards ? await readActivityLogs() : [];
  const newLogs = attributeActivityLogs(beforeLogIds, activityLogs, runtime.checkedReviewLogIds);
  const p15ActivityLogs = newLogs.map((log) => ({
    ...log,
    previousLog: previousLogsByCardId.get(log.cardId) ?? null,
  }));
  const activityCardKeys = new Map(
    [...beforeCards, ...afterCards].map((card) => [card.id, dueCardKey(card)]),
  );
  if (tracksCards) {
    runtime.violationEvidenceContext = {
      ...runtime.violationEvidenceContext,
      beforeCards: databaseCardEvidence(beforeCards),
      afterCards: databaseCardEvidence(afterCards),
      implicitRepetitionTrace: implicitRepetitionTrace.map((event) => ({
        ...event,
        targetCardId: activityCardKeys.get(event.targetCardId) ?? event.targetCardId,
      })),
      activityLogs: newLogs
        .map(({ cardId, conceptId, dimension, rating }) => ({
          cardId: activityCardKeys.get(cardId) ?? conceptId,
          conceptId,
          dimension,
          rating: String(rating),
          previousLog: (() => {
            const previousLog = previousLogsByCardId.get(cardId);
            return previousLog
              ? {
                  rating: previousLog.rating,
                  createdAt: previousLog.createdAt.toISOString(),
                }
              : null;
          })(),
        }))
        .sort(
          (left, right) =>
            left.conceptId.localeCompare(right.conceptId) ||
            (left.dimension ?? '').localeCompare(right.dimension ?? '') ||
            left.cardId.localeCompare(right.cardId) ||
            left.rating.localeCompare(right.rating),
        ),
      behaviors: {
        ...runtime.violationEvidenceContext.behaviors,
        B3PartialExplain: runtime.activeBehaviors.B3PartialExplain,
      },
    };
  }
  const [savedActivity] =
    activity.kind === 'review' || activity.kind === 'learn'
      ? await db
          .select({ status: sessionActivities.status })
          .from(sessionActivities)
          .where(eq(sessionActivities.id, activity.id))
          .limit(1)
      : [];
  const activityCompleted = savedActivity?.status === 'completed';
  if (newLogs.length > 0) {
    const loggedConceptIds = new Set(newLogs.map((log) => log.conceptId));
    runtime.pendingP18 = runtime.pendingP18.filter(
      (event) => !loggedConceptIds.has(event.conceptId),
    );
  }
  const beforeById = new Map(beforeCards.map((card) => [card.id, card]));
  const afterById = new Map(afterCards.map((card) => [card.id, card]));
  const encompassing = tracksCards ? buildEncompassingIndex(content) : undefined;
  if (activity.kind === 'review' && activityCompleted && beforeSchedulerState) {
    const minimumRatingByConcept = new Map<string, number>();
    for (const log of newLogs) {
      const rating = Number(log.rating);
      minimumRatingByConcept.set(
        log.conceptId,
        Math.min(minimumRatingByConcept.get(log.conceptId) ?? Infinity, rating),
      );
    }
    for (const [sourceConceptId, rating] of minimumRatingByConcept) {
      if (rating >= Rating.Good) continue;
      for (const conceptId of dueTopicsCoveredByForAudit(
        sourceConceptId,
        beforeSchedulerState,
        content,
        now,
      )) {
        if (
          newLogs.some((log) => log.conceptId === conceptId) ||
          !afterCards.some(
            (card) => card.conceptId === conceptId && isDueToday(card.dueAt, now, timeZone),
          )
        ) {
          continue;
        }
        if (
          !runtime.pendingP18.some((event) => event.day === day && event.conceptId === conceptId)
        ) {
          runtime.pendingP18.push({ day, conceptId, sourceConceptId });
        }
      }
    }
  }
  if (tracksCards && encompassing && activityCompleted) {
    const sourceConcepts = [...new Set(newLogs.map((log) => log.conceptId))];
    const reviewLogOrder = new Map(
      newLogs.flatMap((log) => {
        if (!log.dimension) return [];
        const order = runtime.reviewActivityDimensionOrder
          .get(activity.id)
          ?.get(`${log.conceptId}/${log.dimension}`);
        return order === undefined ? [] : [[log.cardId, order] as const];
      }),
    );
    const prerequisiteResetContext =
      activity.kind === 'review'
        ? {
            hardPrerequisiteIdsByConcept: new Map(
              [...new Set(p15ActivityLogs.map((log) => log.conceptId))].map((conceptId) => [
                conceptId,
                content.conceptsById
                  .get(conceptId)
                  ?.prereqs.filter((prerequisite) => prerequisite.strength === 'hard')
                  .map((prerequisite) => prerequisite.id) ?? [],
              ]),
            ),
            completedReviewConceptIds,
            coveredDimensionKeys: new Set(
              activity.exerciseIds.flatMap((exerciseId) => {
                const exercise = content.exercisesById.get(exerciseId);
                return exercise?.concept && exercise.dimension
                  ? [`${exercise.concept}/${exercise.dimension}`]
                  : [];
              }),
            ),
          }
        : undefined;
    const p15 = auditP15Trace(
      beforeCards,
      afterCards,
      p15ActivityLogs,
      implicitRepetitionTrace,
      encompassing,
      now,
      timeZone,
      activity.kind === 'learn' ? 'learn' : 'review',
      reviewLogOrder,
      prerequisiteResetContext,
      new Set(
        (
          await db
            .select({ conceptId: placementGrants.conceptId })
            .from(placementGrants)
            .where(and(eq(placementGrants.userId, userId), eq(placementGrants.state, 'withdrawn')))
        ).map((grant) => grant.conceptId),
      ),
    );
    runtime.report.checkedCounts.P15 += p15.checked;
    runtime.violationEvidenceContext = {
      ...runtime.violationEvidenceContext,
      prerequisiteResetEvidence: p15.prerequisiteResetEvidence.map((reset) => ({
        ...reset,
        sourceCardId: activityCardKeys.get(reset.sourceCardId) ?? reset.sourceCardId,
        candidateCardIds: reset.candidateCardIds.map(
          (cardId) => activityCardKeys.get(cardId) ?? cardId,
        ),
        eligibleCardIds: reset.eligibleCardIds.map(
          (cardId) => activityCardKeys.get(cardId) ?? cardId,
        ),
        selectedCardId: reset.selectedCardId
          ? (activityCardKeys.get(reset.selectedCardId) ?? reset.selectedCardId)
          : null,
      })),
    };
    for (const detail of p15.violations) {
      const cardId = detail.split(':', 1)[0] ?? 'implicit-credit';
      const target = beforeCards.find(
        (card) =>
          detail.startsWith(`${p15CardIdentity(card)}:`) ||
          detail.includes(`-> ${p15CardIdentity(card)}`) ||
          detail.includes(`-> ${card.id}`),
      );
      const conceptId = target?.conceptId;
      const entityId = target ? p15CardIdentity(target) : cardId;
      addViolation(runtime, day, 'P15', entityId, [], {
        courseId,
        ...(conceptId ? { conceptId } : {}),
        evidenceConceptIds: [
          ...sourceConcepts,
          ...implicitRepetitionTrace.map(({ sourceConceptId }) => sourceConceptId),
          ...(conceptId ? [conceptId] : []),
        ],
        details: `${activity.kind} credit sources ${sourceConcepts.join(', ') || 'none'}: ${detail}`,
      });
    }
  }
  const nextLocalDay = startOfNextCalendarDay(now, timeZone);
  let positiveImplicitCredits = 0;
  let negativeImplicitCredits = 0;
  for (const card of afterCards) {
    const previous = beforeById.get(card.id);
    if (!previous) continue;
    if (
      (previous.lastReviewAt?.getTime() ?? null) !== (card.lastReviewAt?.getTime() ?? null) ||
      previous.dueAt.getTime() === card.dueAt.getTime() ||
      card.dueAt.getTime() === now.getTime()
    ) {
      continue;
    }
    if (card.dueAt > previous.dueAt) positiveImplicitCredits += 1;
    if (card.dueAt < previous.dueAt && card.dueAt >= nextLocalDay) {
      negativeImplicitCredits += 1;
    }
  }

  let explicitReviews = 0;
  if (activity.kind === 'review') {
    explicitReviews = newLogs.length;

    if (!encompassing) throw new Error('Missing encompassing index for review audit');
    for (const log of newLogs.filter(({ rating }) => rating === String(Rating.Again))) {
      for (const [descendantId, weight] of encompassing.descendants(log.conceptId)) {
        if (weight <= 0) continue;
        for (const previous of beforeCards) {
          if (
            previous.conceptId !== descendantId ||
            !previous.fsrs ||
            (previous.fsrs as { state: number }).state !== State.Review
          ) {
            continue;
          }
          const card = afterById.get(previous.id);
          if (!card) continue;
          const assessment = auditP11DescendantCard(
            runtime.report,
            descendantId,
            previous,
            card,
            newLogs,
            encompassing,
          );
          if (assessment.kind !== 'checked' || !assessment.violates) continue;
          addViolation(runtime, day, 'P11', descendantId, [], {
            courseId,
            conceptId: descendantId,
            details: `Again on ${log.conceptId} with weight ${weight} changed dueAt from ${previous.dueAt.toISOString()} to ${card.dueAt.toISOString()}${assessment.fiReChanged ? ' after FIRe changed the card' : ''}`,
          });
        }
      }
    }
  }
  return {
    ...result,
    explicitReviews,
    positiveImplicitCredits,
    negativeImplicitCredits,
  };
}

function isCourseComplete(course: CourseCatalogPayload['subjects'][number]['courses'][number]) {
  return (
    course.status === 'completed' ||
    (course.topicsTotal > 0 && course.topicsDone >= course.topicsTotal)
  );
}

function syncCourseSummaries(runtime: ProfileRuntime, catalog: CourseCatalogPayload, day: number) {
  const rows = new Map(courseRows(catalog).map((course) => [course.id, course]));
  for (const summary of runtime.report.courses) {
    const row = rows.get(summary.courseId);
    if (!row) continue;
    summary.title = row.title;
    if (isCourseComplete(row) && summary.finishedDay === null) {
      summary.finishedDay = summary.startedDay === null ? 0 : day;
      summary.daysToFinish =
        summary.startedDay === null ? 0 : summary.finishedDay - summary.startedDay + 1;
    }
  }
}

function incompleteCourse(catalog: CourseCatalogPayload, selectedCourseIds: readonly string[]) {
  const selected = new Set(selectedCourseIds);
  return courseRows(catalog).find((course) => selected.has(course.id) && !isCourseComplete(course));
}

function nextCourseInHomeOrder(
  catalog: CourseCatalogPayload,
  selectedCourseIds: readonly string[],
  currentCourseId: string | undefined,
  noProgressDays: Map<string, number>,
) {
  const ordered = courseRows(catalog).filter((course) => selectedCourseIds.includes(course.id));
  const incomplete = ordered.filter((course) => !isCourseComplete(course));
  if (incomplete.length === 0) return undefined;
  const current = incomplete.find((course) => course.id === currentCourseId);
  if (current && (noProgressDays.get(current.id) ?? 0) < 7) return current;

  const currentIndex = ordered.findIndex((course) => course.id === currentCourseId);
  for (let offset = 1; offset <= ordered.length; offset += 1) {
    const index = (currentIndex + offset + ordered.length) % ordered.length;
    const candidate = ordered[index];
    if (!candidate || isCourseComplete(candidate)) continue;
    if ((noProgressDays.get(candidate.id) ?? 0) >= 7) noProgressDays.set(candidate.id, 0);
    return candidate;
  }
  return undefined;
}

function studySkipped(profile: SimulationProfile, day: number): boolean {
  return (profile === 'average' || profile === 'placement') && day % 5 === 0;
}

async function maybeSwitchGraphContent(
  api: SimulatedApi,
  db: Database,
  runtime: ProfileRuntime,
  day: number,
  courseId: string | undefined,
  realContent: ContentIndex,
  graphContent: ContentIndex,
  now: Date,
) {
  if (
    runtime.profile !== 'graph-change' ||
    runtime.report.graphChangeDay !== undefined ||
    courseId !== graphCourseId
  ) {
    return graphContent;
  }
  const [run] = await db
    .select({ status: lessonRuns.status })
    .from(lessonRuns)
    .where(
      and(
        eq(lessonRuns.userId, api.userId ?? ''),
        eq(lessonRuns.conceptId, graphMilestoneConceptId),
      ),
    )
    .orderBy(desc(lessonRuns.updatedAt), desc(lessonRuns.id))
    .limit(1);
  if (run?.status !== 'completed') return graphContent;

  api.setContent(realContent);
  runtime.report.graphChangeDay = day;
  const progress = await readProgress(db, api.userId ?? '');
  const today = await api.require<TodayPayload>('GET', '/today', now);
  const learn = await api.require<LearnPayload>('GET', '/learn', now);
  const page = await fetchCoursePage(api, now, graphCourseId);
  await auditHome(api, now, runtime, day, courseId, today, learn, progress, realContent);
  auditCoursePage(runtime, day, graphCourseId, page, progress, realContent);
  return realContent;
}

function getViolationCounts(violations: SimulationViolation[]): Record<InvariantId, number> {
  return Object.fromEntries(
    invariants.map((invariant) => [
      invariant,
      violations.filter((violation) => violation.invariant === invariant).length,
    ]),
  ) as Record<InvariantId, number>;
}

async function auditCompressionPlan(
  db: Database,
  runtime: ProfileRuntime,
  userId: string,
  content: ContentIndex,
  now: Date,
  day: number,
  courseId: string,
  activities: SimActivity[],
): Promise<number> {
  const state = await new LearnerRepository(db, userId).schedulerState(now, content);
  const dueConceptIds = new Set(
    state.cards
      .filter((card) => isDueToday(card.dueAt, now, state.timezone ?? 'UTC'))
      .map((card) => card.conceptId),
  );
  const remediationConceptIds = new Set(
    state.remediationFlags.flatMap((flag) =>
      flag.status !== 'resolved' && flag.targetPrereqId ? [flag.targetPrereqId] : [],
    ),
  );
  const reviewConceptIds = new Set(
    activities
      .filter((activity) => activity.kind === 'review')
      .flatMap((activity) => [
        ...(activity.conceptId ? [activity.conceptId] : []),
        ...(activity.exerciseIds ?? []).flatMap((exerciseId) => {
          const conceptId = content.exercisesById.get(exerciseId)?.concept;
          return conceptId ? [conceptId] : [];
        }),
      ]),
  );
  const taskConceptIds = activities.flatMap((activity) =>
    activity.kind === 'learn' || activity.kind === 'review'
      ? [
          ...new Set([
            ...(activity.conceptId ? [activity.conceptId] : []),
            ...(activity.exerciseIds ?? []).flatMap((exerciseId) => {
              const conceptId = content.exercisesById.get(exerciseId)?.concept;
              return conceptId ? [conceptId] : [];
            }),
          ]),
        ]
      : [],
  );
  const coverageByTask = new Map(
    [...new Set(taskConceptIds)].map((conceptId) => [
      conceptId,
      new Set([
        ...dueTopicsCoveredByForAudit(conceptId, state, content, now),
        ...(reviewConceptIds.has(conceptId) && dueConceptIds.has(conceptId) ? [conceptId] : []),
      ]),
    ]),
  );
  let coveredSkips = 0;
  for (const dueConceptId of dueConceptIds) {
    const coveringConceptIds = [...coverageByTask]
      .filter(([conceptId, covered]) => conceptId !== dueConceptId && covered.has(dueConceptId))
      .map(([conceptId]) => conceptId);
    if (reviewConceptIds.has(dueConceptId)) {
      const dueReviewTopics = [
        dueConceptId,
        ...dueTopicsCoveredByForAudit(dueConceptId, state, content, now),
      ];
      const reviewIsRedundant = dueReviewTopics.every((reviewTopicId) =>
        [...coverageByTask].some(
          ([conceptId, covered]) => conceptId !== dueConceptId && covered.has(reviewTopicId),
        ),
      );
      if (
        !remediationConceptIds.has(dueConceptId) &&
        reviewIsRedundant &&
        coveringConceptIds.length > 0
      ) {
        addViolation(runtime, day, 'P12', dueConceptId, [], {
          courseId,
          conceptId: dueConceptId,
          details: `explicit review was planned with covering task ${coveringConceptIds[0]}`,
        });
      }
    } else if (coveringConceptIds.length > 0) {
      coveredSkips += 1;
    }
  }
  return coveredSkips;
}

export function retryDecisionEvidence(
  state: SchedulerState,
  content: ContentIndex,
  now: Date,
  budgetMinutes: number,
  eligibleConceptIds: ReadonlySet<string>,
  activities: SimActivity[],
  explanations: ReviewSelectionExplanation[],
  carriedOverActivityIds: ReadonlySet<string> = new Set(),
): SimulationRetryDecisionEvidence[] {
  const dueConceptIds = new Set(
    state.cards
      .filter((card) => isDueToday(card.dueAt, now, state.timezone ?? 'UTC'))
      .map((card) => card.conceptId),
  );
  const haltedLessonIds = new Set(
    state.lessonRuns
      ?.filter(({ status }) => status === 'needs_retry')
      .map(({ conceptId }) => conceptId),
  );
  for (const flag of state.remediationFlags) {
    if (flag.status !== 'resolved' && flag.targetPrereqId && haltedLessonIds.has(flag.conceptId)) {
      dueConceptIds.add(flag.targetPrereqId);
    }
  }
  const preservedInProgressMinutes = p10PreservedActivityMinutes(
    activities,
    carriedOverActivityIds,
  );
  const preservedReviewConceptIds = new Set(
    activities
      .filter(
        (activity) =>
          activity.kind === 'review' &&
          carriedOverActivityIds.has(activity.id) &&
          (activity.status === 'in_progress' || activity.status === 'completed'),
      )
      .flatMap((activity) =>
        activity.exerciseIds.flatMap((exerciseId) => {
          const conceptId = content.exercisesById.get(exerciseId)?.concept;
          return conceptId ? [conceptId] : [];
        }),
      ),
  );
  const reservedDueReviews = explanations
    .filter(
      (explanation) =>
        dueConceptIds.has(explanation.conceptId) &&
        !preservedReviewConceptIds.has(explanation.conceptId) &&
        (explanation.result === 'selected' || explanation.result === 'selected:overdue'),
    )
    .map((explanation) => {
      return {
        conceptId: explanation.conceptId,
        plannedMinutes: explanation.candidateMinutes ?? 0,
        explanationResult: explanation.result,
        ...(explanation.candidateMinutes !== undefined
          ? { candidateMinutes: explanation.candidateMinutes }
          : {}),
        reviewCap: explanation.reviewCap,
        reviewMinutes: explanation.reviewMinutes,
        overdueBypass: explanation.result === 'selected:overdue',
      };
    });
  const reservedDueReviewMinutes = reservedDueReviews.reduce(
    (total, review) => total + review.plannedMinutes,
    0,
  );
  const remainingCapacityMinutes =
    budgetMinutes - preservedInProgressMinutes - reservedDueReviewMinutes;
  const lessonRunsByConcept = new Map(
    (state.lessonRuns ?? []).map((run) => [run.conceptId, run] as const),
  );

  return (state.lessonRuns ?? []).flatMap((run) => {
    if (run.status !== 'needs_retry' || !run.retryAfter) return [];
    const retryAfter = run.retryAfter instanceof Date ? run.retryAfter : new Date(run.retryAfter);
    if (retryAfter.getTime() > now.getTime()) return [];
    const concept = content.conceptsById.get(run.conceptId);
    const candidateMinutes = concept
      ? adjustedMinutesForLearnerPace(concept.est_minutes, state.actualEstimateRatio)
      : null;
    const priorityMinutes = p10SchedulerPriorityLessonMinutes(
      state,
      run.conceptId,
      now,
      activities,
      carriedOverActivityIds,
    );
    const remainingAfterSchedulerPriorityMinutes =
      remainingCapacityMinutes - priorityMinutes.totalMinutes;

    return [
      {
        conceptId: run.conceptId,
        retryAfter: retryAfter.toISOString(),
        retryAfterPassed: true,
        overduePriority: lessonRetryOverdue(state, run.conceptId, now),
        eligible: eligibleConceptIds.has(run.conceptId),
        candidateMinutes,
        preservedInProgressMinutes,
        reservedDueReviewMinutes,
        remainingCapacityMinutes,
        fitsRemainingCapacity:
          candidateMinutes === null
            ? null
            : p10RetryFitsCapacity(
                candidateMinutes,
                budgetMinutes,
                preservedInProgressMinutes,
                reservedDueReviewMinutes,
                0,
              ),
        priorityRetryMinutes: priorityMinutes.overdueRetryMinutes,
        priorityResumedLessonMinutes: priorityMinutes.resumedLessonMinutes,
        priorityFocusLessonMinutes: priorityMinutes.focusLessonMinutes,
        remainingAfterSchedulerPriorityMinutes,
        fitsSchedulerCapacity: p10RetryFitsCapacity(
          candidateMinutes,
          budgetMinutes,
          preservedInProgressMinutes,
          reservedDueReviewMinutes,
          priorityMinutes.totalMinutes,
        ),
        reservedDueReviews,
        selectedInstead: activities
          .filter((activity) => activity.kind !== 'learn' || activity.conceptId !== run.conceptId)
          .map((activity) => {
            const selectedRun = activity.conceptId
              ? lessonRunsByConcept.get(activity.conceptId)
              : undefined;
            return {
              kind: activity.kind,
              conceptId: activity.conceptId ?? null,
              plannedMinutes: activity.plannedMinutes,
              ...(activity.status ? { status: activity.status } : {}),
              ...(selectedRun
                ? {
                    retryStatus: selectedRun.status,
                    ...(selectedRun.retryAfter
                      ? {
                          retryAfter:
                            selectedRun.retryAfter instanceof Date
                              ? selectedRun.retryAfter.toISOString()
                              : selectedRun.retryAfter,
                        }
                      : {}),
                  }
                : {}),
              overduePriority:
                selectedRun?.status === 'needs_retry' &&
                lessonRetryOverdue(state, selectedRun.conceptId, now),
            };
          }),
      },
    ];
  });
}

function setP10EvidenceContext(
  runtime: ProfileRuntime,
  day: number,
  courseId: string,
  retryDecisions: SimulationRetryDecisionEvidence[],
  currentLessonRuns: SimulationLessonRunEvidence[],
) {
  const firstDay = Math.max(1, day - 6);
  const dailyByDay = new Map(runtime.report.dailyStats.map((daily) => [daily.day, daily]));
  runtime.violationEvidenceContext = {
    ...runtime.violationEvidenceContext,
    retryDecisions,
    planHistory: Array.from({ length: day - firstDay + 1 }, (_, index) => {
      const historyDay = firstDay + index;
      const daily = dailyByDay.get(historyDay);
      return {
        day: historyDay,
        courseId: daily?.courseId ?? (historyDay === day ? courseId : null),
        plans: runtime.planEvidenceByDay.get(historyDay) ?? daily?.plans ?? [],
        lessonRunStatuses:
          daily?.lessonRunStatuses ?? (historyDay === day ? currentLessonRuns : []),
      };
    }),
  };
}

function auditSavedSessionPlan(
  runtime: ProfileRuntime,
  day: number,
  courseId: string,
  planLabel: string,
  state: SchedulerState,
  content: ContentIndex,
  now: Date,
  budgetMinutes: number,
  learn: LearnPayload,
  activities: SimActivity[],
  reviewExplanations?: ReviewSelectionExplanation[],
  requestedFocusConceptId?: string,
) {
  runtime.activeBehaviors.B3PartialExplain = false;
  const quiz = activities.find(
    (activity) =>
      activity.kind === 'mixed_quiz' &&
      activity.status !== 'completed' &&
      activity.status !== 'skipped',
  );
  state = filterSchedulerStateForContent(content, {
    ...state,
    pendingQuiz: quiz && { plannedMinutes: quiz.plannedMinutes },
  });
  const explanations =
    reviewExplanations ??
    explainReviewSelection(state, content, now, budgetMinutes, new Set(), {
      focusConceptId: requestedFocusConceptId,
    });
  const planActivities = activities.map((activity, index) => ({
    activityId:
      runtime.activityKeyById.get(activity.id) ??
      `day:${day}|plan:${planLabel}|activity:${index}|${activity.kind}|${activity.conceptId ?? ''}`,
    kind: activity.kind,
    ...(activity.conceptId ? { conceptId: activity.conceptId } : {}),
    ...(activity.projectId ? { projectId: activity.projectId } : {}),
    exerciseIds: activity.exerciseIds ?? [],
    plannedMinutes: activity.plannedMinutes,
    ...(activity.status ? { status: activity.status } : {}),
  }));
  const { usedMinutes, usedReviewMinutes } = planUsageMinutes(activities, planLabel === 'replan');
  const reviewCapMinutes =
    explanations[0]?.reviewCap ??
    Math.floor(budgetMinutes * SCHEDULER_CONFIG.weekday.reviewBudgetRatio);
  const focusConceptId = requestedFocusConceptId;
  const retryDecisions =
    planLabel === 'home plan'
      ? retryDecisionEvidence(
          state,
          content,
          now,
          budgetMinutes,
          p10EligibleConceptIds(state, content, now),
          activities,
          explanations,
        )
      : [];
  const planEvidence: SimulationPlanEvidence = {
    label: planLabel,
    method: 'POST',
    path: planLabel === 'replan' ? '/sessions/:id/replan' : '/sessions',
    requestBody:
      planLabel === 'replan'
        ? {}
        : {
            ...(runtime.activeBehaviors.B1BudgetMinutes !== null
              ? { budgetMinutes: runtime.activeBehaviors.B1BudgetMinutes }
              : {}),
            ...(focusConceptId ? { focusConceptId } : {}),
          },
    budgetMinutes,
    activities: planActivities,
    schedulerExplanations: explanations,
    retryDecisions,
    behaviors: {
      ...runtime.activeBehaviors,
      B2FocusConceptId: focusConceptId ?? null,
    },
    reviewCapMinutes,
    usedMinutes,
    remainingMinutes: Math.max(0, budgetMinutes - usedMinutes),
    remainingReviewCapMinutes: Math.max(0, reviewCapMinutes - usedReviewMinutes),
  };
  const lessonRuns = (state.lessonRuns ?? []).map((run) => ({
    conceptId: run.conceptId,
    status: run.status,
    ...(run.retryAfter !== undefined
      ? {
          retryAfter:
            run.retryAfter instanceof Date ? run.retryAfter.toISOString() : run.retryAfter,
        }
      : {}),
  }));
  runtime.violationEvidenceContext = {
    ...emptyViolationEvidence(),
    beforeCards: schedulerCardEvidence(state, now),
    mastery: state.mastery.map((record) => ({
      conceptId: record.conceptId,
      dimension: record.dimension,
      state: record.state,
      inferred: record.inferred,
    })),
    schedulerExplanations: explanations,
    budgetMinutes,
    reviewCapMinutes,
    usedMinutes,
    remainingMinutes: planEvidence.remainingMinutes,
    remainingReviewCapMinutes: planEvidence.remainingReviewCapMinutes,
    behaviors: {
      ...runtime.activeBehaviors,
      B2FocusConceptId: focusConceptId ?? null,
    },
    retryDecisions,
    planActivities,
    lessonRuns,
  };
  const dayPlans = runtime.planEvidenceByDay.get(day) ?? [];
  runtime.planEvidenceByDay.set(day, [...dayPlans, planEvidence]);
  for (const { projectId, status } of activities) {
    if (
      !projectId ||
      (status !== 'planned' && (status !== 'in_progress' || planLabel === 'replan'))
    )
      continue;
    checkProjectReadiness(
      runtime,
      day,
      projectId,
      courseId,
      {
        masteryByKey: new Map(
          state.mastery.map((record) => [masteryKey(record.conceptId, record.dimension), record]),
        ),
        lessonRuns: (state.lessonRuns ?? []).map(({ conceptId, status }) => ({
          conceptId,
          status,
        })),
      },
      content,
    );
  }
  if (planLabel === 'home plan') {
    const eligibleConceptIds = p10EligibleConceptIds(state, content, now);
    const plannedConceptIds = new Set(
      activities.flatMap((activity) =>
        activity.kind === 'learn' && activity.conceptId ? [activity.conceptId] : [],
      ),
    );
    const fitsSchedulerCapacity = new Map(
      retryDecisions.map((decision) => [decision.conceptId, decision.fitsSchedulerCapacity]),
    );
    for (const conceptId of p10MissingOverdueRetryConcepts(
      state,
      eligibleConceptIds,
      plannedConceptIds,
      now,
      fitsSchedulerCapacity,
    )) {
      if (runtime.overdueRetryReported.has(conceptId)) continue;
      runtime.overdueRetryReported.add(conceptId);
      const retryDecision = retryDecisions.find((decision) => decision.conceptId === conceptId);
      if (retryDecision) {
        setP10EvidenceContext(runtime, day, courseId, [retryDecision], lessonRuns);
      }
      addViolation(runtime, day, 'P10', conceptId, [], {
        courseId,
        conceptId,
        details:
          'an eligible retry was at least two days past retryAfter and had scheduler priority (scheduler.ts:250-254, 974-985, 1530-1540), but the home plan omitted it',
      });
    }
  }
  markChecked(runtime, 'P13');
  const lessonMinutes = learn.choices.flatMap((choice) => {
    const concept = content.conceptsById.get(choice.conceptId);
    if (!concept || !content.lessonsByConcept.has(choice.conceptId)) return [];
    return [adjustedMinutesForLearnerPace(concept.est_minutes, state.actualEstimateRatio)];
  });
  const unfinishedActivityCount = activities.filter(
    (activity) => activity.status !== 'completed' && activity.status !== 'skipped',
  ).length;
  if (p13HasEmptyPlanViolation(unfinishedActivityCount, lessonMinutes, budgetMinutes)) {
    const lesson = learn.choices.find((choice) => {
      const concept = content.conceptsById.get(choice.conceptId);
      return (
        concept !== undefined &&
        content.lessonsByConcept.has(choice.conceptId) &&
        adjustedMinutesForLearnerPace(concept.est_minutes, state.actualEstimateRatio) <=
          budgetMinutes
      );
    });
    addViolation(runtime, day, 'P13', lesson?.conceptId ?? planLabel, [], {
      courseId,
      ...(lesson ? { conceptId: lesson.conceptId } : {}),
      details: `${planLabel} had no activities although an unlocked lesson fit the ${budgetMinutes}-minute budget`,
    });
  }

  const dueCards = state.cards.filter((card) =>
    isDueToday(card.dueAt, now, state.timezone ?? 'UTC'),
  );
  const coveredOrSelectedConceptIds = new Set(
    explanations
      .filter(
        ({ result }) =>
          result === 'covered' || result === 'selected' || result === 'selected:overdue',
      )
      .map(({ conceptId }) => conceptId),
  );
  const checkedDueCards = dueCards.filter(
    (card) =>
      coveredOrSelectedConceptIds.has(card.conceptId) &&
      p14ExplanationForCard(card, explanations) !== undefined,
  );
  for (const _card of checkedDueCards) markChecked(runtime, 'P14');
  const activityCoverage = activities.map((activity) => ({
    conceptIds: [
      ...new Set([
        ...(activity.conceptId ? [activity.conceptId] : []),
        ...(activity.exerciseIds ?? []).flatMap((exerciseId) => {
          const conceptId = content.exercisesById.get(exerciseId)?.concept;
          return conceptId ? [conceptId] : [];
        }),
      ]),
    ],
    cardIds: activityDueCardCoverage(activity, state, content, now),
    selectedCardIds: new Set(
      activity.kind === 'review'
        ? (activity.exerciseIds ?? []).flatMap((exerciseId) => {
            const exercise = content.exercisesById.get(exerciseId);
            if (!exercise) return [];
            return state.cards
              .filter(
                (card) =>
                  card.conceptId === exercise.concept && card.dimension === exercise.dimension,
              )
              .map(dueCardKey);
          })
        : [],
    ),
    unfinished: activity.status !== 'completed' && activity.status !== 'skipped',
  }));
  for (const cardId of p14UncoveredDueCards(
    dueCards.map((card) => ({
      cardId: dueCardKey(card),
      conceptId: card.conceptId,
      dimension: card.dimension,
    })),
    activityCoverage,
    explanations,
  )) {
    const card = dueCards.find((item) => dueCardKey(item) === cardId);
    addViolation(runtime, day, 'P14', cardId, [], {
      courseId,
      ...(card ? { conceptId: card.conceptId } : {}),
      details: `${planLabel} did not save an unfinished activity covering the due-today card`,
    });
  }
  for (const pending of runtime.pendingP18.filter((event) => event.day === day)) {
    const overdueDays = Math.max(
      0,
      ...state.cards
        .filter((card) => card.conceptId === pending.conceptId)
        .map(
          (card) =>
            localDayOrdinal(now, state.timezone ?? 'UTC') -
            localDayOrdinal(new Date(card.dueAt), state.timezone ?? 'UTC'),
        ),
    );
    const remainsDue = state.cards.some(
      (card) =>
        card.conceptId === pending.conceptId &&
        isDueToday(card.dueAt, now, state.timezone ?? 'UTC'),
    );
    const coveringActivities = activities.filter(
      (activity) =>
        activity.status !== 'completed' &&
        activity.status !== 'skipped' &&
        activityDueCoverage(activity, state, content, now).has(pending.conceptId),
    );
    const selectedReviewMinutes = activities
      .filter(
        (activity) =>
          activity.kind === 'review' &&
          activity.status !== 'completed' &&
          activity.status !== 'skipped' &&
          !(planLabel === 'replan' && activity.status === 'in_progress'),
      )
      .reduce((total, activity) => total + activity.plannedMinutes, 0);
    const reviewCap = explanations[0]?.reviewCap ?? Math.floor(budgetMinutes * 0.3);
    const usedNonReviewMinutes = Math.max(0, usedMinutes - selectedReviewMinutes);
    const planCoversTopic = p18PlanCoversTopic(
      coveringActivities,
      selectedReviewMinutes,
      Math.max(0, budgetMinutes - usedNonReviewMinutes),
      reviewCap,
      overdueDays,
    );
    const explanation = explanations.find((item) => item.conceptId === pending.conceptId);
    if (
      typeof explanation?.candidateMinutes !== 'number' ||
      !Number.isFinite(explanation.candidateMinutes) ||
      explanation.candidateMinutes <= 0
    ) {
      continue;
    }
    markChecked(runtime, 'P18');
    if (
      p18HasMissedPickup(
        remainsDue,
        false,
        planCoversTopic,
        explanation.candidateMinutes,
        planEvidence.remainingMinutes,
        planEvidence.remainingReviewCapMinutes,
        overdueDays,
      )
    ) {
      addViolation(runtime, day, 'P18', pending.conceptId, [], {
        courseId,
        conceptId: pending.conceptId,
        evidenceConceptIds: [pending.sourceConceptId],
        details: `${planLabel} omitted due topic after low-credit review of ${pending.sourceConceptId}`,
      });
    }
  }
  runtime.pendingP18 = runtime.pendingP18.filter((event) => event.day > day);
  if (planLabel !== 'replan' || reviewExplanations) {
    auditReviewPlanInvariants(
      runtime,
      day,
      courseId,
      state,
      content,
      now,
      budgetMinutes,
      activities,
      explanations,
      planLabel === 'replan',
    );
  }
}

function summarizeDailyStats(stats: DailySimulationStats[]) {
  const mean = (values: number[]) =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    lessonsPerDayMean: mean(stats.map((item) => item.lessons)),
    lessonsPerDayMax: Math.max(0, ...stats.map((item) => item.lessons)),
    reviewsPerDayMean: mean(stats.map((item) => item.reviews)),
    reviewsPerDayMax: Math.max(0, ...stats.map((item) => item.reviews)),
    explicitReviews: stats.reduce((total, item) => total + item.explicitReviews, 0),
    positiveImplicitCredits: stats.reduce((total, item) => total + item.positiveImplicitCredits, 0),
    negativeImplicitCredits: stats.reduce((total, item) => total + item.negativeImplicitCredits, 0),
    coveredSkips: stats.reduce((total, item) => total + item.coveredSkips, 0),
  };
}

function remediationReport(
  runtime: ProfileRuntime,
  content: ContentIndex,
): RemediationSimulationReport {
  const report: RemediationSimulationReport = {
    totals: {
      halts: runtime.haltEvents.length,
      noProgressHalts: runtime.haltEvents.filter((event) => event.noProgress).length,
      remediationFlagsOpened: runtime.remediationFlagEvents.length,
      remedialReviewsCompleted: new Set(
        runtime.remedialReviewEvents.map((event) => `${event.day}|${event.prerequisiteId}`),
      ).size,
      retriesStarted: runtime.retryEvents.length,
      lessonsCompletedAfterRetry: runtime.postRetryCompletionEvents.length,
    },
    halts: runtime.haltEvents,
    flagsOpened: runtime.remediationFlagEvents,
    remedialReviewsCompleted: runtime.remedialReviewEvents,
    retriesStarted: runtime.retryEvents,
    lessonsCompletedAfterRetry: runtime.postRetryCompletionEvents,
  };
  if (runtime.profile !== 'gap') return report;

  const timelines = new Map<string, GapLessonTimeline>();
  const timelineFor = (conceptId: string) => {
    let timeline = timelines.get(conceptId);
    if (!timeline) {
      timeline = {
        conceptId,
        title: content.conceptsById.get(conceptId)?.title ?? conceptId,
        haltDays: [],
        retryDays: [],
        flagsOpened: [],
        prereqsReviewed: [],
        completionDays: [],
      };
      timelines.set(conceptId, timeline);
    }
    return timeline;
  };
  for (const event of runtime.haltEvents) timelineFor(event.conceptId).haltDays.push(event.day);
  for (const event of runtime.retryEvents) timelineFor(event.conceptId).retryDays.push(event.day);
  for (const event of runtime.remediationFlagEvents) {
    timelineFor(event.conceptId).flagsOpened.push({
      day: event.day,
      prerequisiteId: event.prerequisiteId,
    });
  }
  for (const event of runtime.remedialReviewEvents) {
    timelineFor(event.conceptId).prereqsReviewed.push({
      day: event.day,
      prerequisiteId: event.prerequisiteId,
    });
  }
  for (const event of runtime.postRetryCompletionEvents) {
    timelineFor(event.conceptId).completionDays.push(event.day);
  }
  report.gapTimeline = [...timelines.values()].sort(
    (left, right) =>
      (left.haltDays[0] ?? 0) - (right.haltDays[0] ?? 0) ||
      left.conceptId.localeCompare(right.conceptId),
  );
  return report;
}

async function simulateProfile(
  db: Database,
  realContent: ContentIndex,
  options: LearnerSimulationOptions,
  profile: SimulationProfile,
): Promise<ProfileSimulationReport> {
  const scriptedScenario = isScriptedScenarioProfile(profile);
  const timeZone = options.timeZone ?? (scriptedScenario ? 'UTC' : 'America/Los_Angeles');
  const startDate = options.startDate ?? (scriptedScenario ? '2026-01-14' : '2026-01-01');
  const seed = seedFor(profile);
  const graphContent = toGraphChangeContent(realContent);
  const initialContent = profile === 'graph-change' ? graphContent : realContent;
  const firstNow = localNoon(startDate, timeZone);
  const api = new SimulatedApi(db, initialContent, timeZone, firstNow, profile);
  const report: ProfileSimulationReport = {
    profile,
    seed,
    dayCap: options.days,
    daysSimulated: 0,
    finishedAllCourses: false,
    courses: [],
    dailyStats: [],
    projectsOffered: [],
    papersRecorded: [],
    remediation: {
      totals: {
        halts: 0,
        noProgressHalts: 0,
        remediationFlagsOpened: 0,
        remedialReviewsCompleted: 0,
        retriesStarted: 0,
        lessonsCompletedAfterRetry: 0,
      },
      halts: [],
      flagsOpened: [],
      remedialReviewsCompleted: [],
      retriesStarted: [],
      lessonsCompletedAfterRetry: [],
    },
    p11CheckedEvents: 0,
    p11AmbiguousEvents: 0,
    checkedCounts: Object.fromEntries(
      checkedInvariantIds.map((id) => [id, 0]),
    ) as CheckedInvariantCounts,
    totals: {
      lessonsPerDayMean: 0,
      lessonsPerDayMax: 0,
      reviewsPerDayMean: 0,
      reviewsPerDayMax: 0,
      answers: 0,
      explicitReviews: 0,
      positiveImplicitCredits: 0,
      negativeImplicitCredits: 0,
      coveredSkips: 0,
      wrongAnswers: 0,
      wrongPercent: 0,
    },
    violationCounts: getViolationCounts([]),
    violations: [],
  };
  const runtime: ProfileRuntime = {
    profile,
    seed,
    report,
    violationKeys: new Set(),
    offeredProjectKeys: new Set(),
    lastPracticed: new Map(),
    choiceStartability: new Map(),
    answered: 0,
    wrongAnswers: 0,
    weakPrereqs: weakPrereqsForProfile(profile),
    completedRemedialReviews: new Set(),
    lastHaltedPointIndex: new Map(),
    haltEvents: [],
    remediationFlagEvents: [],
    remedialReviewEvents: [],
    retryEvents: [],
    postRetryCompletionEvents: [],
    openFlagKeys: new Set(),
    awaitingRetryStart: new Set(),
    retriedConcepts: new Set(),
    completedAfterRetryConcepts: new Set(),
    noProgressHalts: new Map(),
    overdueRetryReported: new Set(),
    activityKeyById: new Map(),
    decisionAttempts: new Map(),
    checkedReviewLogIds: new Set(),
    pendingP18: [],
    violationEvidenceContext: emptyViolationEvidence(),
    planEvidenceByDay: new Map(),
    activeBehaviors: {
      B1BudgetMinutes: null,
      B2FocusConceptId: null,
      B3PartialExplain: false,
      B4Replan: false,
    },
    reviewActivityDimensionOrder: new Map(),
    reviewActivityAttemptIndex: new Map(),
    placement: emptyPlacementAuditState(),
  };
  api.afterCall = async () => {
    if (api.userId) await recordLessonRunsAtWithdrawal(db, api.userId, runtime.placement);
  };
  let activeContent = initialContent;
  let currentCourseId: string | undefined;
  let selectedCourseIds: string[] = [];
  let catalog: CourseCatalogPayload | undefined;
  const noProgressDays = new Map<string, number>();
  const overdueReported = new Set<string>();

  try {
    catalog = await fetchCourseCatalog(api, firstNow);
    const allCourseIds = courseRows(catalog).map((course) => course.id);
    selectedCourseIds = options.courseIds
      ? allCourseIds.filter((courseId) => options.courseIds?.includes(courseId))
      : allCourseIds;
    for (const courseId of options.courseIds ?? []) {
      if (!allCourseIds.includes(courseId)) {
        throw new Error(`Unknown course ${courseId}`);
      }
    }
    report.courses = courseRows(catalog)
      .filter((course) => selectedCourseIds.includes(course.id))
      .map((course) => ({
        courseId: course.id,
        title: course.title,
        startedDay: null,
        finishedDay: null,
        daysToFinish: null,
      }));
    syncCourseSummaries(runtime, catalog, 0);

    const dayLimit =
      isScriptedScenarioProfile(profile) || profile === 'scenario-quizzes' ? 1 : options.days;
    for (let day = 1; day <= dayLimit; day += 1) {
      let now = localNoon(dateAfter(startDate, day - 1), timeZone);
      const currentCatalog = await fetchCourseCatalog(api, now);
      syncCourseSummaries(runtime, currentCatalog, day - 1);
      const next = nextCourseInHomeOrder(
        currentCatalog,
        selectedCourseIds,
        currentCourseId,
        noProgressDays,
      );
      if (!next) break;
      const courseId = next.id;
      currentCourseId = courseId;
      const skip = studySkipped(profile, day);
      const summary = report.courses.find((item) => item.courseId === courseId);
      if (!skip && summary?.startedDay === null) {
        if (profile !== 'graph-change' || runtime.report.graphChangeDay !== undefined) {
          activeContent = realContent;
        }
        await startCourse(api, activeContent, runtime, courseId, now, day);
        if (summary) summary.startedDay = day;
      } else {
        await api.require('PUT', '/course/active', now, { courseId });
      }

      if (day === 1 && isScriptedScenarioProfile(profile)) {
        const userId = api.userId;
        if (!userId) throw new Error('Simulation API did not create a learner');
        await seedScriptedScenario(db, userId, profile, activeContent, now);
      }
      if (profile === 'scenario-quizzes') {
        const userId = api.userId;
        if (!userId) throw new Error('Simulation API did not create a learner');
        await db
          .insert(lessonRuns)
          .values(
            activeContent.lessons.map(({ concept }) => ({
              userId,
              conceptId: concept,
              status: 'completed' as const,
              startedAt: now,
              updatedAt: now,
              completedAt: now,
            })),
          )
          .onConflictDoNothing();
        await db.insert(xpEvents).values({
          userId,
          kind: 'knowledge_point',
          sourceKey: 'scenario:quiz-xp',
          amount: 150,
          earnedAt: now,
          localDate: localDate(now, timeZone),
        });
      }
      const today = await api.require<TodayPayload>('GET', '/today', now);
      const learn = await api.require<LearnPayload>('GET', '/learn', now);
      const userId = api.userId;
      if (!userId) throw new Error('Simulation API did not create a learner');
      const budgetChoices: Array<number | undefined> = [10, 20, 30, 45, 60, undefined];
      const scriptedScenario = isScriptedScenarioProfile(profile);
      const selectedBudget =
        profile === 'scenario-quizzes'
          ? 60
          : scriptedScenario
            ? 20
            : budgetChoices[
                Math.floor(
                  decisionRandom(profile, day, 'daily-session', 'budget', 1) * budgetChoices.length,
                )
              ];
      const budgetRequest = selectedBudget === undefined ? {} : { budgetMinutes: selectedBudget };
      const stateBeforeSession = await new LearnerRepository(db, userId).schedulerState(
        now,
        activeContent,
      );
      const hadDueReviews = stateBeforeSession.cards.some((card) =>
        isDueToday(card.dueAt, now, stateBeforeSession.timezone ?? timeZone),
      );
      const shouldReplan =
        !scriptedScenario && decisionRandom(profile, day, 'daily-session', 'replan', 1) < 0.2;
      const shouldFocusDueReview =
        !scriptedScenario &&
        hadDueReviews &&
        decisionRandom(profile, day, 'daily-session', 'due-review-focus', 1) < 0.3;
      runtime.activeBehaviors = {
        B1BudgetMinutes: selectedBudget ?? null,
        B2FocusConceptId: null,
        B3PartialExplain: false,
        B4Replan: shouldReplan,
      };
      const progress = await readProgress(db, userId);
      const initialBudgetMinutes = selectedBudget ?? today.budgetMinutes;
      const initialExplanations = explainReviewSelection(
        stateBeforeSession,
        activeContent,
        now,
        initialBudgetMinutes,
      );
      const homePlanActivities = today.plan.activities.map((activity) => {
        const sessionActivity = activity as Partial<SessionActivity>;
        return {
          kind: activity.kind,
          ...(activity.conceptId ? { conceptId: activity.conceptId } : {}),
          ...(sessionActivity.projectId ? { projectId: sessionActivity.projectId } : {}),
          exerciseIds: sessionActivity.exerciseIds ?? [],
          plannedMinutes: activity.plannedMinutes,
        };
      });
      const homeUsedMinutes = homePlanActivities.reduce(
        (total, activity) => total + activity.plannedMinutes,
        0,
      );
      const homeReviewCap =
        initialExplanations[0]?.reviewCap ??
        Math.floor(initialBudgetMinutes * SCHEDULER_CONFIG.weekday.reviewBudgetRatio);
      const homeReviewMinutes = homePlanActivities
        .filter((activity) => activity.kind === 'review')
        .reduce((total, activity) => total + activity.plannedMinutes, 0);
      runtime.violationEvidenceContext = {
        ...emptyViolationEvidence(),
        beforeCards: schedulerCardEvidence(stateBeforeSession, now),
        mastery: [...progress.masteryByKey].map(([key, record]) => {
          const separator = key.lastIndexOf(':');
          return {
            conceptId: key.slice(0, separator),
            dimension: key.slice(separator + 1),
            state: record.state,
            inferred: record.inferred,
          };
        }),
        schedulerExplanations: initialExplanations,
        budgetMinutes: initialBudgetMinutes,
        reviewCapMinutes: homeReviewCap,
        usedMinutes: homeUsedMinutes,
        remainingMinutes: Math.max(0, initialBudgetMinutes - homeUsedMinutes),
        remainingReviewCapMinutes: Math.max(0, homeReviewCap - homeReviewMinutes),
        behaviors: { ...runtime.activeBehaviors, B2FocusConceptId: null },
        planActivities: homePlanActivities,
        lessonRuns: progress.lessonRuns.map((run) => ({
          conceptId: run.conceptId,
          status: run.status,
          ...(run.retryAfter ? { retryAfter: run.retryAfter.toISOString() } : {}),
        })),
      };
      await auditHome(api, now, runtime, day, courseId, today, learn, progress, activeContent);
      const pageBefore = await fetchCoursePage(api, now, courseId);
      auditCoursePage(runtime, day, courseId, pageBefore, progress, activeContent);
      for (const unit of pageBefore.units) {
        if (unit.project?.available) offerProject(runtime, day, courseId, unit.project.id);
      }

      const daily: DailySimulationStats = {
        day,
        date: localDate(now, timeZone),
        courseId,
        studied: !skip,
        lessons: 0,
        reviews: 0,
        reviewAttempts: 0,
        explicitReviews: 0,
        positiveImplicitCredits: 0,
        negativeImplicitCredits: 0,
        coveredSkips: 0,
        newTopicsCompleted: 0,
        offers: [],
        plans: [],
        lessonRunStatuses: [],
        courseTopics: coursePageTopics(pageBefore).map((topic) => ({
          conceptId: topic.conceptId,
          title: topic.title,
          status: topic.status,
          missingPrereqs: (topic.needs ?? []).map(({ id, title }) => ({ id, title })),
          ...(topic.retry ? { retry: topic.retry } : {}),
        })),
      };
      let ranDueFocus = false;
      if (!skip) {
        const session = object(
          await api.require('POST', '/sessions', now, {
            kind: today.sessionKind,
            ...budgetRequest,
          }),
        );
        const sessionId = text(session.id);
        if (!sessionId) throw new Error('Session start did not return an id');
        const paperId = pageBefore.units
          .find((unit) => unit.unit === pageBefore.currentUnit)
          ?.papers.find((paper) => paper.status !== 'completed')?.id;
        const activities = list(session.activities).map((activity, index) => {
          const parsed = object(activity) as unknown as SimActivity;
          runtime.activityKeyById.set(
            parsed.id,
            `day:${day}|session:home|activity:${index}|${parsed.kind}|${parsed.conceptId ?? ''}`,
          );
          return parsed.kind === 'paper' && paperId ? { ...parsed, paperId } : parsed;
        });
        await auditQuizOffer(
          db,
          runtime,
          day,
          userId,
          today.quizOffer,
          activities,
          selectedBudget ?? today.budgetMinutes,
        );
        auditSavedSessionPlan(
          runtime,
          day,
          courseId,
          'home plan',
          stateBeforeSession,
          activeContent,
          now,
          selectedBudget ?? today.budgetMinutes,
          learn,
          activities,
        );
        daily.coveredSkips += await auditCompressionPlan(
          db,
          runtime,
          userId,
          activeContent,
          now,
          day,
          courseId,
          activities,
        );
        daily.offers.push(...activities.map(sessionOffer));
        for (const activity of activities) {
          if (await activityWasSkipped(db, activity.id)) continue;
          const activityProgress = await readProgress(db, userId);
          const activityState = await new LearnerRepository(db, userId).schedulerState(
            now,
            activeContent,
          );
          if (
            !(await auditSessionActivity(
              api,
              runtime,
              now,
              day,
              courseId,
              sessionId,
              activity,
              activityProgress,
              activityState,
              activeContent,
            ))
          )
            continue;
          const result = await processActivityWithMetrics(
            api,
            db,
            activeContent,
            runtime,
            now,
            timeZone,
            day,
            courseId,
            sessionId,
            activity,
          );
          if (activity.kind === 'mixed_quiz') now = api.nextQuizTime(now);
          daily.lessons += result.lessons;
          daily.reviews += result.reviews;
          daily.reviewAttempts += result.reviewAttempts;
          daily.explicitReviews += result.explicitReviews;
          daily.positiveImplicitCredits += result.positiveImplicitCredits;
          daily.negativeImplicitCredits += result.negativeImplicitCredits;
        }
        if (shouldReplan) {
          const stateBeforeReplan = await new LearnerRepository(db, userId).schedulerState(
            now,
            activeContent,
          );
          const replanLearn = await api.require<LearnPayload>('GET', '/learn', now);
          const originalActivityIds = new Set(activities.map((activity) => activity.id));
          const existingActivities = await db
            .select()
            .from(sessionActivities)
            .where(eq(sessionActivities.sessionId, sessionId))
            .orderBy(asc(sessionActivities.idx));
          const existingPlannedActivities = existingActivities as unknown as PlannedActivity[];
          const remainingBudget = Math.max(
            0,
            (selectedBudget ?? today.budgetMinutes) -
              existingActivities
                .filter(
                  (activity) =>
                    activity.status === 'completed' || activity.status === 'in_progress',
                )
                .reduce((total, activity) => total + activity.plannedMinutes, 0),
          );
          const reviewExplanations = explainReviewSelectionForReplan(
            stateBeforeReplan,
            activeContent,
            now,
            remainingBudget,
            existingPlannedActivities,
          ).results;
          const replanned = await api.require<{ activities: SessionActivity[] }>(
            'POST',
            `/sessions/${sessionId}/replan`,
            now,
          );
          const newActivities = newActivitiesForReplan(
            replanned.activities as SimActivity[],
            originalActivityIds,
          ).map((activity, index) => {
            const parsed = activity as SimActivity;
            runtime.activityKeyById.set(
              parsed.id,
              `day:${day}|session:replan|activity:${index}|${parsed.kind}|${parsed.conceptId ?? ''}`,
            );
            return parsed.kind === 'paper' && paperId ? { ...parsed, paperId } : parsed;
          });
          auditSavedSessionPlan(
            runtime,
            day,
            courseId,
            'replan',
            stateBeforeReplan,
            activeContent,
            now,
            remainingBudget,
            replanLearn,
            replanned.activities as SimActivity[],
            reviewExplanations,
          );
          daily.coveredSkips += await auditCompressionPlan(
            db,
            runtime,
            userId,
            activeContent,
            now,
            day,
            courseId,
            newActivities,
          );
          daily.offers.push(...newActivities.map(sessionOffer));
          for (const activity of newActivities) {
            if (await activityWasSkipped(db, activity.id)) continue;
            const activityProgress = await readProgress(db, userId);
            const activityState = await new LearnerRepository(db, userId).schedulerState(
              now,
              activeContent,
            );
            if (
              !(await auditSessionActivity(
                api,
                runtime,
                now,
                day,
                courseId,
                sessionId,
                activity,
                activityProgress,
                activityState,
                activeContent,
              ))
            )
              continue;
            const result = await processActivityWithMetrics(
              api,
              db,
              activeContent,
              runtime,
              now,
              timeZone,
              day,
              courseId,
              sessionId,
              activity,
            );
            if (activity.kind === 'mixed_quiz') now = api.nextQuizTime(now);
            daily.lessons += result.lessons;
            daily.reviews += result.reviews;
            daily.reviewAttempts += result.reviewAttempts;
            daily.explicitReviews += result.explicitReviews;
            daily.positiveImplicitCredits += result.positiveImplicitCredits;
            daily.negativeImplicitCredits += result.negativeImplicitCredits;
          }
        }
        await api.require('POST', `/sessions/${sessionId}/end`, now);
      }
      if (!skip && shouldFocusDueReview) {
        const refreshedLearn = await api.require<LearnPayload>('GET', '/learn', now);
        const choices = refreshedLearn.choices;
        if (choices.length > 0) {
          const choiceIndex = Math.floor(
            decisionRandom(profile, day, 'daily-session', 'due-review-choice', 1) * choices.length,
          );
          const choice = choices[choiceIndex];
          if (choice) {
            const stateBeforeFocus = await new LearnerRepository(db, userId).schedulerState(
              now,
              activeContent,
            );
            stateBeforeFocus.inProgressConceptId = choice.conceptId;
            const focusedSession = object(
              await api.require('POST', '/sessions', now, {
                kind: today.sessionKind,
                ...budgetRequest,
                focusConceptId: choice.conceptId,
              }),
            );
            const focusedSessionId = text(focusedSession.id);
            if (!focusedSessionId) {
              throw new Error(`Due-review focused session for ${choice.conceptId} returned no id`);
            }
            const focusedActivities = list(focusedSession.activities).map((activity, index) => {
              const parsed = object(activity) as unknown as SimActivity;
              runtime.activityKeyById.set(
                parsed.id,
                `day:${day}|session:due-focus:${choice.conceptId}|activity:${index}|${parsed.kind}|${parsed.conceptId ?? ''}`,
              );
              return parsed;
            });
            auditSavedSessionPlan(
              runtime,
              day,
              courseId,
              'due-review focus plan',
              stateBeforeFocus,
              activeContent,
              now,
              selectedBudget ?? today.budgetMinutes,
              refreshedLearn,
              focusedActivities,
              undefined,
              choice.conceptId,
            );
            daily.coveredSkips += await auditCompressionPlan(
              db,
              runtime,
              userId,
              activeContent,
              now,
              day,
              courseId,
              focusedActivities,
            );
            daily.offers.push(...focusedActivities.map(sessionOffer));
            for (const activity of focusedActivities) {
              if (await activityWasSkipped(db, activity.id)) continue;
              const activityProgress = await readProgress(db, userId);
              const activityState = await new LearnerRepository(db, userId).schedulerState(
                now,
                activeContent,
              );
              if (
                !(await auditSessionActivity(
                  api,
                  runtime,
                  now,
                  day,
                  courseId,
                  focusedSessionId,
                  activity,
                  activityProgress,
                  activityState,
                  activeContent,
                ))
              )
                continue;
              const result = await processActivityWithMetrics(
                api,
                db,
                activeContent,
                runtime,
                now,
                timeZone,
                day,
                courseId,
                focusedSessionId,
                activity,
              );
              if (activity.kind === 'mixed_quiz') now = api.nextQuizTime(now);
              daily.lessons += result.lessons;
              daily.reviews += result.reviews;
              daily.reviewAttempts += result.reviewAttempts;
              daily.explicitReviews += result.explicitReviews;
              daily.positiveImplicitCredits += result.positiveImplicitCredits;
              daily.negativeImplicitCredits += result.negativeImplicitCredits;
            }
            await api.require('POST', `/sessions/${focusedSessionId}/end`, now);
            ranDueFocus = true;
          }
        }
      }
      if (!skip && !ranDueFocus && daily.lessons + daily.reviews === 0) {
        const refreshedLearn = await api.require<LearnPayload>('GET', '/learn', now);
        const choice = refreshedLearn.choices[0];
        if (choice) {
          const stateBeforeFocus = await new LearnerRepository(db, userId).schedulerState(
            now,
            activeContent,
          );
          stateBeforeFocus.inProgressConceptId = choice.conceptId;
          const focusedSession = object(
            await api.require('POST', '/sessions', now, {
              kind: today.sessionKind,
              ...budgetRequest,
              focusConceptId: choice.conceptId,
            }),
          );
          const focusedSessionId = text(focusedSession.id);
          if (!focusedSessionId) {
            throw new Error(`Focused session for ${choice.conceptId} returned no id`);
          }
          const focusedActivities = list(focusedSession.activities).map((activity, index) => {
            const parsed = object(activity) as unknown as SimActivity;
            runtime.activityKeyById.set(
              parsed.id,
              `day:${day}|session:focus:${choice.conceptId}|activity:${index}|${parsed.kind}|${parsed.conceptId ?? ''}`,
            );
            return parsed;
          });
          auditSavedSessionPlan(
            runtime,
            day,
            courseId,
            'empty-day focus plan',
            stateBeforeFocus,
            activeContent,
            now,
            selectedBudget ?? today.budgetMinutes,
            refreshedLearn,
            focusedActivities,
            undefined,
            choice.conceptId,
          );
          daily.coveredSkips += await auditCompressionPlan(
            db,
            runtime,
            userId,
            activeContent,
            now,
            day,
            courseId,
            focusedActivities,
          );
          daily.offers.push(...focusedActivities.map(sessionOffer));
          for (const activity of focusedActivities) {
            if (await activityWasSkipped(db, activity.id)) continue;
            const activityProgress = await readProgress(db, userId);
            const activityState = await new LearnerRepository(db, userId).schedulerState(
              now,
              activeContent,
            );
            if (
              !(await auditSessionActivity(
                api,
                runtime,
                now,
                day,
                courseId,
                focusedSessionId,
                activity,
                activityProgress,
                activityState,
                activeContent,
              ))
            )
              continue;
            const result = await processActivityWithMetrics(
              api,
              db,
              activeContent,
              runtime,
              now,
              timeZone,
              day,
              courseId,
              focusedSessionId,
              activity,
            );
            if (activity.kind === 'mixed_quiz') now = api.nextQuizTime(now);
            daily.lessons += result.lessons;
            daily.reviews += result.reviews;
            daily.reviewAttempts += result.reviewAttempts;
            daily.explicitReviews += result.explicitReviews;
            daily.positiveImplicitCredits += result.positiveImplicitCredits;
            daily.negativeImplicitCredits += result.negativeImplicitCredits;
          }
          await api.require('POST', `/sessions/${focusedSessionId}/end`, now);
        }
      }
      const pageAfter = await fetchCoursePage(api, now, courseId);
      daily.newTopicsCompleted = newTopicsCompleted(pageBefore, pageAfter);
      daily.plans = runtime.planEvidenceByDay.get(day) ?? [];
      const endOfDayProgress = await readProgress(db, userId);
      daily.lessonRunStatuses = endOfDayProgress.lessonRuns.map((run) => ({
        conceptId: run.conceptId,
        status: run.status,
        ...(run.retryAfter ? { retryAfter: run.retryAfter.toISOString() } : {}),
      }));
      report.dailyStats.push(daily);

      for (const [conceptId, halt] of runtime.noProgressHalts) {
        if (day > halt.day + 1 && !halt.reviewed && !halt.violationReported) {
          halt.violationReported = true;
          addViolation(runtime, day, 'P9', conceptId, halt.targetPrereqIds, {
            courseId,
            conceptId,
            details: 'no-progress halt lacked a key-prerequisite review within one day',
          });
        }
      }

      const afterStudyCatalog = await fetchCourseCatalog(api, now);
      const currentCourse = courseRows(afterStudyCatalog).find((course) => course.id === courseId);
      const courseComplete = currentCourse ? isCourseComplete(currentCourse) : false;
      const noProgress =
        !courseComplete && daily.newTopicsCompleted === 0 && daily.reviewAttempts === 0;
      noProgressDays.set(courseId, noProgress ? (noProgressDays.get(courseId) ?? 0) + 1 : 0);
      if (
        day >= 7 &&
        courseRows(afterStudyCatalog).some(
          (course) => selectedCourseIds.includes(course.id) && !isCourseComplete(course),
        )
      ) {
        const firstDay = day - 6;
        const remedialReviewDays = new Set(runtime.remedialReviewEvents.map((event) => event.day));
        if (p5HasNoWorkWindow(report.dailyStats, day, remedialReviewDays)) {
          setP5EvidenceContext(runtime, day);
          addViolation(runtime, day, 'P5', courseId, [], {
            courseId,
            details: `days ${firstDay}-${day} had no lesson attempts, review attempts, or remedial reviews`,
          });
        }
      }

      await reviewCardAudit(runtime, db, userId, now, day, timeZone, overdueReported);
      await auditPlacementGrants({
        db,
        userId,
        content: activeContent,
        day,
        state: runtime.placement,
        coursePageTopics: coursePageTopics(pageAfter),
        plannedLearnConceptIds: daily.plans.flatMap((plan) =>
          plan.activities.flatMap((activity) =>
            activity.kind === 'learn' && activity.conceptId ? [activity.conceptId] : [],
          ),
        ),
        countsComplete: (conceptId) => isDone(conceptId, endOfDayProgress, activeContent),
        markChecked: (invariant) => markChecked(runtime, invariant),
        addViolation: (invariant, conceptId, details, evidenceConceptIds, grants) =>
          addViolation(runtime, day, invariant, conceptId, [], {
            courseId,
            conceptId,
            details,
            evidenceConceptIds,
            placementGrants: grants,
          }),
      });
      const switchedContent = await maybeSwitchGraphContent(
        api,
        db,
        runtime,
        day,
        courseId,
        realContent,
        graphContent,
        now,
      );
      if (switchedContent === realContent) activeContent = realContent;
      catalog = await fetchCourseCatalog(api, now);
      syncCourseSummaries(runtime, catalog, day);
      report.daysSimulated = day;
      options.onProgress?.(
        `${profile}: day ${day}/${options.days}, ${courseId}, ` +
          `${report.courses.filter((item) => item.finishedDay !== null).length}/` +
          `${report.courses.length} courses complete`,
      );
      if (!incompleteCourse(catalog, selectedCourseIds)) break;
    }

    const finalNow = localNoon(
      dateAfter(startDate, Math.max(report.daysSimulated - 1, 0)),
      timeZone,
    );
    catalog = await fetchCourseCatalog(api, finalNow);
    syncCourseSummaries(runtime, catalog, report.daysSimulated);
    if (profile === 'diligent') {
      for (const course of courseRows(catalog)) {
        if (!selectedCourseIds.includes(course.id) || isCourseComplete(course)) continue;
        addViolation(runtime, options.days, 'P7', course.id, [], { courseId: course.id });
      }
    }
    report.finishedAllCourses = report.courses.every((course) => course.finishedDay !== null);
    report.totals = {
      ...summarizeDailyStats(report.dailyStats),
      answers: runtime.answered,
      wrongAnswers: runtime.wrongAnswers,
      wrongPercent: runtime.answered === 0 ? 0 : (runtime.wrongAnswers / runtime.answered) * 100,
    };
    report.remediation = remediationReport(runtime, realContent);
    report.violationCounts = getViolationCounts(report.violations);
    return report;
  } finally {
    await api.cleanup();
  }
}

export async function simulateLearners(
  db: Database,
  content: ContentIndex,
  options: LearnerSimulationOptions,
): Promise<LearnerSimulationReport> {
  validateSimulationCourseIds(
    options.courseIds,
    new Set(content.coursesById.keys()),
    options.scenarioContent?.courses.map(({ id }) => id),
  );
  const startedAt = performance.now();
  const profiles: ProfileSimulationReport[] = [];
  const skippedProfiles: LearnerSimulationReport['skippedProfiles'] = [];
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    for (const profile of options.profiles) {
      options.onProgress?.(`Starting ${profile}`);
      const scenarioProfile = isScriptedScenarioProfile(profile);
      if (scenarioProfile && !options.scenarioContent) {
        throw new Error(`Scripted scenario ${profile} requires fixture content`);
      }
      const skipReason = scenarioCourseFilterSkipReason(
        profile,
        options.courseIds,
        options.scenarioContent?.courses[0]?.id,
      );
      if (skipReason) {
        skippedProfiles.push({ profile, reason: skipReason });
        options.onProgress?.(`Skipping ${profile}: ${skipReason}`);
        continue;
      }
      const profileContent = scenarioProfile
        ? scriptedScenarioContent(profile, options.scenarioContent ?? content)
        : content;
      profiles.push(await simulateProfile(db, profileContent, options, profile));
    }
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
  return {
    generatedAt: new Date().toISOString(),
    timeZone: options.timeZone ?? 'America/Los_Angeles',
    dayCap: options.days,
    runtimeMs: Math.round(performance.now() - startedAt),
    profiles,
    skippedProfiles,
  };
}

function durationText(milliseconds: number): string {
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(0)}s`;
}

function exampleText(violation: SimulationViolation): string {
  const missing =
    violation.missingAncestors.length > 0
      ? `; missing ancestors: ${violation.missingAncestors.join(', ')}`
      : '';
  const startable =
    violation.startable === undefined
      ? ''
      : `; API startable: ${violation.startable ? 'yes' : 'no'}`;
  const context = violation.courseId ? ` in ${violation.courseId}` : '';
  const details = violation.details ? ` (${violation.details})` : '';
  const evidence = violation.evidence;
  const evidenceText = JSON.stringify({
    beforeCards: evidence.beforeCards,
    afterCards: evidence.afterCards,
    activityLogs: evidence.activityLogs,
    mastery: evidence.mastery,
    schedulerExplanations: evidence.schedulerExplanations,
    retryDecisions: evidence.retryDecisions,
    implicitRepetitionTrace: evidence.implicitRepetitionTrace,
    prerequisiteResetEvidence: evidence.prerequisiteResetEvidence,
    budgetMinutes: evidence.budgetMinutes,
    reviewCapMinutes: evidence.reviewCapMinutes,
    usedMinutes: evidence.usedMinutes,
    remainingMinutes: evidence.remainingMinutes,
    remainingReviewCapMinutes: evidence.remainingReviewCapMinutes,
    behaviors: evidence.behaviors,
    planActivities: evidence.planActivities,
    lessonRuns: evidence.lessonRuns,
    planHistory: evidence.planHistory,
    quiz: evidence.quiz,
  });
  return `Day ${violation.day}: \`${violation.entityId}\`${context}${missing}${startable}${details}; evidence: ${evidenceText}`;
}

export function renderMarkdownReport(report: LearnerSimulationReport): string {
  const lines = [
    '# Learner simulation report',
    '',
    `- Generated: ${report.generatedAt}`,
    `- Runtime: ${durationText(report.runtimeMs)}`,
    `- Time zone: ${report.timeZone}`,
    `- Day cap: ${report.dayCap}`,
    '',
    '## Summary',
    '',
    '| Profile | Courses finished | Days simulated | Lessons/day mean / max | Reviews/day mean / max | Explicit reviews | Implicit + / − | Covered skips | P11 checks | P11 ambiguous | Wrong |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.profiles.map(
      (profile) =>
        `| ${profile.profile} | ${profile.courses.filter((course) => course.finishedDay !== null).length}/${profile.courses.length} | ${profile.daysSimulated} | ${profile.totals.lessonsPerDayMean.toFixed(2)} / ${profile.totals.lessonsPerDayMax} | ${profile.totals.reviewsPerDayMean.toFixed(2)} / ${profile.totals.reviewsPerDayMax} | ${profile.totals.explicitReviews} | ${profile.totals.positiveImplicitCredits} / ${profile.totals.negativeImplicitCredits} | ${profile.totals.coveredSkips} | ${profile.p11CheckedEvents} | ${profile.p11AmbiguousEvents} | ${profile.totals.wrongPercent.toFixed(1)}% |`,
    ),
    '',
  ];
  if (report.skippedProfiles.length > 0) {
    lines.push(
      '## Skipped profiles',
      '',
      ...report.skippedProfiles.map(({ profile, reason }) => `- ${profile}: ${reason}.`),
      '',
    );
  }
  for (const profile of report.profiles) {
    lines.push(
      `## ${profile.profile}`,
      '',
      `Seed: \`${profile.seed}\`. Finished all selected courses: **${profile.finishedAllCourses}**.`,
    );
    if (profile.graphChangeDay !== undefined) {
      lines.push(`Graph-change content switched on day ${profile.graphChangeDay}.`);
    }
    const remediation = profile.remediation;
    const flagList =
      remediation.flagsOpened
        .map((event) => `day ${event.day} ${event.conceptId} → ${event.prerequisiteId}`)
        .join('; ') || 'none';
    lines.push(
      '',
      '| Course | Started day | Finished day | Days to finish |',
      '| --- | ---: | ---: | ---: |',
      ...profile.courses.map(
        (course) =>
          `| ${course.title} (\`${course.courseId}\`) | ${course.startedDay ?? 'not started'} | ${course.finishedDay ?? 'not finished'} | ${course.daysToFinish ?? 'n/a'} |`,
      ),
      '',
      `Lessons/day: mean ${profile.totals.lessonsPerDayMean.toFixed(2)}, max ${profile.totals.lessonsPerDayMax}.`,
      `Reviews/day: mean ${profile.totals.reviewsPerDayMean.toFixed(2)}, max ${profile.totals.reviewsPerDayMax}.`,
      `P11 checked events: ${profile.p11CheckedEvents}.`,
      `P11 ambiguous events: ${profile.p11AmbiguousEvents}.`,
      `Wrong answers: ${profile.totals.wrongAnswers}/${profile.totals.answers} (${profile.totals.wrongPercent.toFixed(1)}%).`,
      `Remediation: ${remediation.totals.halts} halts (${remediation.totals.noProgressHalts} no-progress); ${remediation.totals.remediationFlagsOpened} flags opened [${flagList}]; ${remediation.totals.remedialReviewsCompleted} remedial reviews completed; ${remediation.totals.retriesStarted} retries started; ${remediation.totals.lessonsCompletedAfterRetry} lessons completed after retry.`,
      '',
    );
    if (profile.profile === 'gap') {
      lines.push('### Gap lesson timelines', '');
      if (remediation.gapTimeline?.length) {
        for (const timeline of remediation.gapTimeline) {
          const flags = timeline.flagsOpened
            .map((event) => `day ${event.day} ${event.prerequisiteId}`)
            .join(', ');
          const reviews = timeline.prereqsReviewed
            .map((event) => `day ${event.day} ${event.prerequisiteId}`)
            .join(', ');
          lines.push(
            `- **${timeline.title}** (\`${timeline.conceptId}\`): halted ${timeline.haltDays.map((day) => `day ${day}`).join(', ') || 'never'}; retried ${timeline.retryDays.map((day) => `day ${day}`).join(', ') || 'never'}; flags opened ${flags || 'none'}; prereqs reviewed ${reviews || 'none'}; completed ${timeline.completionDays.map((day) => `day ${day}`).join(', ') || 'not after a retry'}.`,
          );
        }
      } else {
        lines.push('No affected lessons halted.', '');
      }
      lines.push('');
    }
    lines.push('### Violations', '');
    lines.push(
      '| Invariant | Violations | Checked |',
      '| --- | ---: | ---: |',
      ...invariants.map(
        (invariant) =>
          `| ${invariant} | ${profile.violationCounts[invariant]} | ${checkedInvariantIds.includes(invariant as CheckedInvariantId) ? profile.checkedCounts[invariant as CheckedInvariantId] : '—'} |`,
      ),
      '',
    );
    for (const invariant of invariants) {
      const violations = profile.violations.filter((item) => item.invariant === invariant);
      lines.push(`#### ${invariant} (${violations.length})`, '');
      if (violations.length === 0) {
        lines.push('No violations observed.', '');
        continue;
      }
      lines.push(...violations.slice(0, 10).map((violation) => `- ${exampleText(violation)}`), '');
    }
    const p5Violations = profile.violations.filter((item) => item.invariant === 'P5');
    if (p5Violations.length > 0) {
      lines.push('### P5 daily offers and course state', '');
      for (const violation of p5Violations) {
        const firstDay = Math.max(1, violation.day - 6);
        for (const daily of profile.dailyStats.filter(
          (item) => item.day >= firstDay && item.day <= violation.day,
        )) {
          const offers =
            daily.offers
              .map((offer) => {
                const id = offer.conceptId ?? offer.projectId ?? offer.paperId;
                const reviewTopics = offer.reviewTopics?.map((topic) => topic.conceptId).join(', ');
                return id
                  ? `${offer.kind} ${id}`
                  : reviewTopics
                    ? `${offer.kind} ${reviewTopics}`
                    : offer.kind;
              })
              .join('; ') || 'no session activities';
          lines.push(`- Day ${daily.day} (${daily.courseId ?? 'no course'}): ${offers}.`);
          for (const plan of daily.plans) {
            const activities =
              plan.activities
                .map(
                  (activity) =>
                    `${activity.kind} ${activity.conceptId ?? activity.projectId ?? ''} (${activity.plannedMinutes}m${activity.status ? `, ${activity.status}` : ''})`,
                )
                .join('; ') || 'no activities';
            lines.push(
              `  - ${plan.label} ${plan.path}, effective budget ${plan.budgetMinutes}m, focus ${plan.requestBody.focusConceptId ?? 'none'}: ${activities}.`,
            );
            lines.push(
              `  - Scheduler: ${plan.schedulerExplanations.map((item) => `${item.conceptId}=${item.result}${item.coveringConceptId ? `:${item.coveringConceptId}` : ''}`).join('; ') || 'no due-review explanations'}.`,
            );
            lines.push(`  - Behaviors: ${JSON.stringify(plan.behaviors)}.`);
          }
          lines.push(
            `  - Lesson runs: ${daily.lessonRunStatuses.map((run) => `${run.conceptId}=${run.status}`).join('; ') || 'none'}.`,
          );
        }
        const evidence = profile.dailyStats.find((item) => item.day === violation.day);
        if (evidence) {
          lines.push(
            `- Day ${violation.day} topics remaining: ${
              evidence.courseTopics
                .filter((topic) => topic.status !== 'complete')
                .map(
                  (topic) =>
                    `\`${topic.conceptId}\` (${topic.status}; missingPrereqs: ${topic.missingPrereqs.map((prereq) => prereq.id).join(', ') || 'none'})`,
                )
                .join('; ') || 'none'
            }.`,
          );
          for (const topic of evidence.courseTopics.filter((item) => item.retry)) {
            lines.push(
              `- Day ${violation.day} retry state for \`${topic.conceptId}\`: after ${topic.retry?.after ?? 'no delay'}; review first ${topic.retry?.reviewFirst.map((item) => item.id).join(', ') || 'none'}.`,
            );
          }
        }
      }
      lines.push('');
    }
    lines.push('### Project and paper activity', '');
    lines.push(
      `Projects offered: ${profile.projectsOffered.length === 0 ? 'none' : profile.projectsOffered.map((item) => `day ${item.day} ${item.projectId}`).join(', ')}.`,
    );
    lines.push(
      `Papers recorded: ${profile.papersRecorded.length === 0 ? 'none' : profile.papersRecorded.map((item) => `day ${item.day} ${item.paperId}`).join(', ')}.`,
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}
