import type { CourseCatalogPayload, CoursePayload, LearnPayload } from '@academy/contracts/course';
import type { SessionActivity, TodayPayload } from '@academy/contracts/sessions';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { Card } from 'ts-fsrs';
import { Rating, State } from 'ts-fsrs';
import { createApp } from '../src/app.js';
import type { ContentEdge, ContentIndex } from '../src/content/types.js';
import type { Database } from '../src/db/client.js';
import { LearnerRepository } from '../src/db/repository.js';
import {
  diagnosticRuns,
  lessonQuizAttempts,
  lessonQuizItems,
  lessonRuns,
  mastery,
  remediationFlags,
  reviewCards,
  reviewLogs,
  sessionActivities,
  users,
} from '../src/db/schema.js';
import { buildEncompassingIndex, type EncompassingIndex } from '../src/learning/encompassing.js';
import { isDueToday, startOfNextCalendarDay } from '../src/learning/fsrs.js';
import { implicitRepetition } from '../src/learning/implicit-repetition.js';
import { keyPrereqsForPoint, masteryKey, prerequisiteMet } from '../src/learning/prerequisites.js';
import {
  adjustedMinutesForLearnerPace,
  explainReviewSelection,
  explainReviewSelectionForReplan,
  type PlannedActivity,
  type ReviewSelectionExplanation,
  SCHEDULER_CONFIG,
  type SchedulerState,
} from '../src/learning/scheduler.js';
import type { MasteryState } from '../src/learning/types.js';
import { localDateKey } from '../src/learning/xp.js';
import { answerFor, exerciseFor, wrongAnswerFor } from './learner-simulation-support.js';

export const simulationProfiles = [
  'diligent',
  'average',
  'struggling',
  'forgetful',
  'placement',
  'graph-change',
  'gap',
] as const;

export type SimulationProfile = (typeof simulationProfiles)[number];
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
  | 'P19';

type CheckedInvariantId = 'P13' | 'P14' | 'P15' | 'P16' | 'P17' | 'P18' | 'P19';
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

export interface SimulationMasteryEvidence {
  conceptId: string;
  dimension: string;
  state: string;
  inferred: boolean;
}

export interface SimulationViolationEvidence {
  beforeCards: SimulationCardEvidence[];
  afterCards: SimulationCardEvidence[];
  activityLogs: Array<{ cardId: string; conceptId: string; rating: string }>;
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
}

export interface LearnerSimulationOptions {
  profiles: SimulationProfile[];
  days: number;
  courseIds?: string[];
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
  staleRetryReported: Set<string>;
  activityKeyById: Map<string, string>;
  decisionAttempts: Map<string, number>;
  violationEvidenceContext: SimulationViolationEvidence;
  planEvidenceByDay: Map<number, SimulationPlanEvidence[]>;
  activeBehaviors: SimulationViolationEvidence['behaviors'];
  reviewActivitySourceOrder: Map<string, Map<string, number>>;
  reviewActivityAttemptIndex: Map<string, number>;
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
];

const checkedInvariantIds: CheckedInvariantId[] = ['P13', 'P14', 'P15', 'P16', 'P17', 'P18', 'P19'];

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
  private app: ReturnType<typeof createApp>;
  private now: Date;
  private cookie: string | undefined;
  private readonly requestOrdinals = new Map<string, number>();
  readonly failedRequests: SimulatedApiFailure[] = [];

  constructor(
    private readonly db: Database,
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
      .select({ state: diagnosticRuns.state })
      .from(diagnosticRuns)
      .where(
        and(
          eq(diagnosticRuns.userId, userId),
          eq(diagnosticRuns.kind, 'placement'),
          eq(diagnosticRuns.status, 'completed'),
        ),
      )
      .orderBy(desc(diagnosticRuns.startedAt), desc(diagnosticRuns.id)),
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
  for (const run of placements) {
    const state = object(run.state);
    for (const conceptId of list(state.known)) {
      if (typeof conceptId === 'string') placedOut.add(conceptId);
    }
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

function isDone(conceptId: string, progress: LearnerProgress, content: ContentIndex): boolean {
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
  > & { evidenceConceptIds?: string[] } = {},
) {
  const key = `${day}|${invariant}|${entityId}|${fields.details ?? ''}`;
  if (runtime.violationKeys.has(key)) return;
  runtime.violationKeys.add(key);
  const { evidenceConceptIds = [], ...violationFields } = fields;
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
  for (const explanation of schedulerExplanations) {
    relatedConceptIds.add(explanation.conceptId);
    if (explanation.coveringConceptId) relatedConceptIds.add(explanation.coveringConceptId);
  }
  const evidence: SimulationViolationEvidence = {
    ...context,
    beforeCards: context.beforeCards.filter((card) => relatedConceptIds.has(card.conceptId)),
    afterCards: context.afterCards.filter((card) => relatedConceptIds.has(card.conceptId)),
    activityLogs: context.activityLogs.filter((log) => relatedConceptIds.has(log.conceptId)),
    mastery: context.mastery.filter((record) => relatedConceptIds.has(record.conceptId)),
    schedulerExplanations,
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

export function p14UncoveredDueCards(
  dueCards: readonly { cardId: string; conceptId: string }[],
  activityCoverage: readonly {
    conceptIds: readonly string[];
    cardIds: ReadonlySet<string>;
    selectedCardIds: ReadonlySet<string>;
    unfinished: boolean;
  }[],
  explanations: readonly ReviewSelectionExplanation[],
): string[] {
  const explanationByConcept = new Map(
    explanations
      .filter(
        ({ result }) =>
          result === 'covered' || result === 'selected' || result === 'selected:overdue',
      )
      .map((explanation) => [explanation.conceptId, explanation]),
  );
  return dueCards.flatMap(({ cardId, conceptId }) => {
    const explanation = explanationByConcept.get(conceptId);
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

export function p16HasOverduePrecedenceViolation(
  droppedReviewOverdueDays: number,
  selectedReviewOverdueDays: number,
): boolean {
  return droppedReviewOverdueDays >= selectedReviewOverdueDays + 2;
}

export function p17ReviewFitsRemaining(
  reviewMinutes: number,
  remainingBudgetMinutes: number,
  remainingReviewCapMinutes: number,
): boolean {
  return (
    reviewMinutes > 0 &&
    reviewMinutes <= remainingBudgetMinutes &&
    reviewMinutes <= remainingReviewCapMinutes
  );
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
): boolean {
  return remainsDue && !hasReviewLog && !planCoversTopic;
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
  const coverageByActivity = unfinished.map((activity) =>
    activityDueCoverage(activity, state, content, now),
  );
  const allCovered = new Set(coverageByActivity.flatMap((coverage) => [...coverage]));
  const nonRemediationReviews = unfinished.flatMap((activity) =>
    activity.kind === 'review'
      ? reviewConceptIdsForActivity(activity)
          .filter((conceptId) => !openRemediationConceptIds.has(conceptId))
          .map((conceptId) => ({ activity, conceptId }))
      : [],
  );
  const overdueDays = (conceptId: string) =>
    Math.max(
      0,
      ...state.cards
        .filter(
          (card) =>
            card.conceptId === conceptId && isDueToday(card.dueAt, now, state.timezone ?? 'UTC'),
        )
        .map((card) =>
          Math.max(
            0,
            localDayOrdinal(now, state.timezone ?? 'UTC') -
              localDayOrdinal(new Date(card.dueAt), state.timezone ?? 'UTC'),
          ),
        ),
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
    markChecked(runtime, 'P17');
    if (p17ReviewFitsRemaining(reviewMinutes, remainingBudgetMinutes, remainingReviewCapMinutes)) {
      addViolation(runtime, day, 'P17', explanation.conceptId, [], {
        courseId,
        conceptId: explanation.conceptId,
        details: `uncovered due review of ${reviewMinutes} adjusted minutes fits the ${remainingBudgetMinutes}-minute remaining budget and ${remainingReviewCapMinutes}-minute review cap`,
      });
    }

    if (nonRemediationReviews.length === 0) continue;
    markChecked(runtime, 'P16');
    const droppedOverdueDays = overdueDays(explanation.conceptId);
    for (const selected of nonRemediationReviews) {
      const selectedCoverage = activityDueCoverage(selected.activity, state, content, now);
      const selectedOverdueDays = Math.max(
        0,
        ...[...selectedCoverage].map((conceptId) => overdueDays(conceptId)),
      );
      if (p16HasOverduePrecedenceViolation(droppedOverdueDays, selectedOverdueDays)) {
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
  for (const activity of unfinished) {
    const coverage = activityDueCoverage(activity, state, content, now);
    if (activity.kind === 'review') {
      for (const conceptId of reviewConceptIdsForActivity(activity)) {
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
    for (const conceptId of coverage) coveredBefore.add(conceptId);
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
  progress: LearnerProgress,
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
  for (const run of progress.lessonRuns) {
    if (
      run.status === 'needs_retry' &&
      run.haltedAt &&
      now.getTime() - run.haltedAt.getTime() > 7 * 86_400_000 &&
      !runtime.staleRetryReported.has(run.conceptId)
    ) {
      runtime.staleRetryReported.add(run.conceptId);
      addViolation(runtime, day, 'P10', run.conceptId, [], {
        ...(courseId ? { courseId } : {}),
        conceptId: run.conceptId,
        details: 'lesson remained needs_retry for more than seven days',
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

function auditSession(
  runtime: ProfileRuntime,
  now: Date,
  day: number,
  courseId: string,
  activities: SimActivity[],
  progress: LearnerProgress,
  state: SchedulerState,
  content: ContentIndex,
) {
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
  for (const activity of activities) {
    if (activity.kind === 'learn' && activity.conceptId) {
      checkLessonReadiness(runtime, day, courseId, [activity.conceptId], progress, content);
    }
    if (activity.projectId) {
      checkProjectReadiness(runtime, day, activity.projectId, courseId, progress, content);
    }
  }
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
  if (runtime.profile !== 'placement') {
    await api.require('POST', `/courses/${courseId}/start`, now, { method: 'beginning' });
    return;
  }
  const placement = object(await api.require('POST', '/placement', now, { courseId }));
  const placementId = text(placement.id);
  if (!placementId) throw new Error('Placement start did not return a run id');
  const course = content.coursesById.get(courseId);
  const topics = [...new Set(course?.units.flatMap((unit) => unit.concepts) ?? [])];
  const knownTopics = new Set(topics.slice(0, Math.ceil(topics.length / 3)));
  for (let step = 0; step < 64; step += 1) {
    const next = object(await api.require('GET', `/placement/${placementId}/next`, now));
    const exercise = object(next.exercise);
    const exerciseId = text(exercise.id);
    if (!exerciseId) break;
    const conceptId = text(exercise.concept) ?? text(next.conceptId) ?? '';
    const know = knownTopics.has(conceptId);
    const body = know
      ? {
          exerciseId,
          answer: answerForProfile(content, exerciseId, 0, true),
        }
      : { exerciseId, dontKnow: true };
    const result = object(await api.require('POST', `/placement/${placementId}/answer`, now, body));
    recordOutcome(runtime, conceptId, day, know ? numeric(result.correct, 1) : 0);
    if (result.complete === true || result.completed === true) break;
  }
  await api.require('GET', `/placement/${placementId}/results`, now);
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
    if (overdueDays > 7 && !reportedCards.has(card.id)) {
      reportedCards.add(card.id);
      addViolation(runtime, day, 'P6', card.conceptId, [], {
        conceptId: card.conceptId,
        details: `review card ${card.id} is ${overdueDays} days overdue`,
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
          runtime.weakPrereqs.includes(prereqId) && !runtime.completedRemedialReviews.has(prereqId),
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
    const sourceOrder = runtime.reviewActivitySourceOrder.get(activityId) ?? new Map();
    sourceOrder.set(conceptId, attemptIndex);
    runtime.reviewActivitySourceOrder.set(activityId, sourceOrder);
  }
  const intendedCorrect = wantsCorrect(runtime, conceptId, day, activityId, exerciseId);
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
  rating: string;
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
}

function p15CardIdentity(card: P15CardSnapshot): string {
  return card.dimension ? `${card.conceptId}/${card.dimension}` : card.id;
}

export function auditP15ImplicitCredits(
  beforeCards: readonly P15CardSnapshot[],
  afterCards: readonly P15CardSnapshot[],
  activityLogs: readonly P11ActivityLog[],
  sourceConceptOrder: readonly string[],
  encompassing: Pick<EncompassingIndex, 'weight' | 'ancestors' | 'descendants'>,
  now: Date,
  timeZone: string,
  activityKind: 'learn' | 'review' = 'review',
): { checked: number; violations: string[] } {
  const logsByConcept = new Map<string, number[]>();
  for (const log of activityLogs) {
    const ratings = logsByConcept.get(log.conceptId) ?? [];
    ratings.push(Number(log.rating));
    logsByConcept.set(log.conceptId, ratings);
  }
  const explicitCardIds = new Set(activityLogs.map((log) => log.cardId));
  const expectedById = new Map(beforeCards.map((card) => [card.id, card]));
  const actualById = new Map(afterCards.map((card) => [card.id, card]));
  const checkedCards = new Set<string>();
  let appliedUpdates = 0;
  for (const sourceConceptId of new Set(sourceConceptOrder)) {
    const ratings = logsByConcept.get(sourceConceptId);
    if (!ratings?.length) continue;
    const rating =
      activityKind === 'learn'
        ? ratings.includes(Rating.Again)
          ? undefined
          : ratings.every((value) => value === Rating.Good)
            ? Rating.Good
            : Rating.Hard
        : (Math.min(...ratings) as Rating);
    if (rating === undefined) continue;
    const positive = rating === Rating.Hard || rating === Rating.Good;
    const relatedConcepts = positive
      ? new Set(encompassing.ancestors(sourceConceptId).keys())
      : rating === Rating.Again
        ? new Set(encompassing.descendants(sourceConceptId).keys())
        : new Set<string>();
    for (const card of beforeCards) {
      const weight = encompassing.weight(sourceConceptId, card.conceptId);
      if (
        weight <= 0 ||
        !relatedConcepts.has(card.conceptId) ||
        explicitCardIds.has(card.id) ||
        (!positive && rating !== Rating.Again)
      ) {
        continue;
      }
      const current = expectedById.get(card.id);
      if (!current) continue;
      const update = implicitRepetition(
        { fsrs: current.fsrs as Card, dueAt: current.dueAt },
        { weight, rating, now, timeZone, enableFuzz: false },
      );
      if (!update) continue;
      expectedById.set(card.id, { ...current, fsrs: update.fsrs, dueAt: update.dueAt });
      checkedCards.add(card.id);
      appliedUpdates += 1;
    }
  }
  const violations: string[] = [];
  for (const cardId of checkedCards) {
    const expected = expectedById.get(cardId);
    const actual = actualById.get(cardId);
    if (!expected || !actual) {
      violations.push(
        `${expected ? p15CardIdentity(expected) : cardId}: expected implicit update was missing`,
      );
      continue;
    }
    const expectedFsrs = expected.fsrs as Card;
    const actualFsrs = actual.fsrs as Card;
    if (
      expected.dueAt.getTime() !== actual.dueAt.getTime() ||
      JSON.stringify(expectedFsrs) !== JSON.stringify(actualFsrs) ||
      (expected.lastReviewAt?.getTime() ?? null) !== (actual.lastReviewAt?.getTime() ?? null)
    ) {
      violations.push(
        `${p15CardIdentity(expected)}: expected ${JSON.stringify({ dueAt: expected.dueAt, fsrs: expected.fsrs, lastReviewAt: expected.lastReviewAt })}, actual ${JSON.stringify({ dueAt: actual.dueAt, fsrs: actual.fsrs, lastReviewAt: actual.lastReviewAt })}`,
      );
    }
  }
  return { checked: activityLogs.length + appliedUpdates, violations };
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

function implicitCreditSourceOrder(
  activity: SimActivity,
  content: ContentIndex,
  activityLogs: readonly P11ActivityLog[],
): string[] {
  const loggedConceptIds = new Set(activityLogs.map(({ conceptId }) => conceptId));
  if (activity.kind === 'learn' && activity.conceptId) {
    return loggedConceptIds.has(activity.conceptId) ? [activity.conceptId] : [];
  }
  const lastExerciseIndex = new Map<string, number>();
  for (const [index, exerciseId] of (activity.exerciseIds ?? []).entries()) {
    const conceptId = content.exercisesById.get(exerciseId)?.concept;
    if (conceptId && loggedConceptIds.has(conceptId)) lastExerciseIndex.set(conceptId, index);
  }
  return [...loggedConceptIds].sort(
    (left, right) =>
      (lastExerciseIndex.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (lastExerciseIndex.get(right) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right),
  );
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
  const beforeLogIds = new Set(tracksCards ? (await readActivityLogs()).map(({ id }) => id) : []);
  runtime.activeBehaviors.B3PartialExplain = false;
  if (activity.kind === 'review') {
    runtime.reviewActivityAttemptIndex.set(activity.id, 0);
    runtime.reviewActivitySourceOrder.set(activity.id, new Map());
  }
  const result = await processActivity(
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
  const activityCardKeys = new Map(
    [...beforeCards, ...afterCards].map((card) => [card.id, dueCardKey(card)]),
  );
  if (tracksCards) {
    runtime.violationEvidenceContext = {
      ...runtime.violationEvidenceContext,
      beforeCards: databaseCardEvidence(beforeCards),
      afterCards: databaseCardEvidence(afterCards),
      activityLogs: newLogs
        .map(({ cardId, conceptId, rating }) => ({
          cardId: activityCardKeys.get(cardId) ?? conceptId,
          conceptId,
          rating: String(rating),
        }))
        .sort(
          (left, right) =>
            left.conceptId.localeCompare(right.conceptId) ||
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
    const recordedOrder = runtime.reviewActivitySourceOrder.get(activity.id);
    const sourceConceptOrder =
      activity.kind === 'review' && recordedOrder
        ? [...new Set(newLogs.map((log) => log.conceptId))].sort(
            (left, right) =>
              (recordedOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
                (recordedOrder.get(right) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right),
          )
        : implicitCreditSourceOrder(activity, content, newLogs);
    const p15 = auditP15ImplicitCredits(
      beforeCards,
      afterCards,
      newLogs,
      sourceConceptOrder,
      encompassing,
      now,
      timeZone,
      activity.kind === 'learn' ? 'learn' : 'review',
    );
    runtime.report.checkedCounts.P15 += p15.checked;
    for (const detail of p15.violations) {
      const cardId = detail.split(':', 1)[0] ?? 'implicit-credit';
      const conceptId = beforeCards.find(
        (card) => `${card.conceptId}/${card.dimension}` === cardId || card.id === cardId,
      )?.conceptId;
      addViolation(runtime, day, 'P15', cardId, [], {
        courseId,
        ...(conceptId ? { conceptId } : {}),
        details: detail,
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
) {
  runtime.activeBehaviors.B3PartialExplain = false;
  const explanations =
    reviewExplanations ??
    explainReviewSelection(state, content, now, budgetMinutes, new Set(), {
      focusConceptId: state.inProgressConceptId,
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
  const unfinished = activities.filter(
    (activity) => activity.status !== 'completed' && activity.status !== 'skipped',
  );
  const usedMinutes = unfinished.reduce((total, activity) => total + activity.plannedMinutes, 0);
  const reviewCapMinutes =
    explanations[0]?.reviewCap ??
    Math.floor(budgetMinutes * SCHEDULER_CONFIG.weekday.reviewBudgetRatio);
  const usedReviewMinutes = unfinished
    .filter((activity) => activity.kind === 'review')
    .reduce((total, activity) => total + activity.plannedMinutes, 0);
  const focusConceptId = state.inProgressConceptId;
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
    planActivities,
    lessonRuns,
  };
  const dayPlans = runtime.planEvidenceByDay.get(day) ?? [];
  runtime.planEvidenceByDay.set(day, [...dayPlans, planEvidence]);
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
  const checkedDueCards = dueCards.filter((card) =>
    coveredOrSelectedConceptIds.has(card.conceptId),
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
    checkedDueCards.map((card) => ({
      cardId: dueCardKey(card),
      conceptId: card.conceptId,
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
    markChecked(runtime, 'P18');
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
          (planLabel !== 'replan' || activity.status === 'planned'),
      )
      .reduce((total, activity) => total + activity.plannedMinutes, 0);
    const planCoversTopic = coveringActivities.some(
      (activity) =>
        activity.kind !== 'review' || selectedReviewMinutes <= Math.floor(budgetMinutes * 0.3),
    );
    if (p18HasMissedPickup(remainsDue, false, planCoversTopic)) {
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
  const timeZone = options.timeZone ?? 'America/Los_Angeles';
  const startDate = options.startDate ?? '2026-01-01';
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
    staleRetryReported: new Set(),
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
    reviewActivitySourceOrder: new Map(),
    reviewActivityAttemptIndex: new Map(),
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

    for (let day = 1; day <= options.days; day += 1) {
      const now = localNoon(dateAfter(startDate, day - 1), timeZone);
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

      const today = await api.require<TodayPayload>('GET', '/today', now);
      const learn = await api.require<LearnPayload>('GET', '/learn', now);
      const userId = api.userId;
      if (!userId) throw new Error('Simulation API did not create a learner');
      const budgetChoices: Array<number | undefined> = [10, 20, 30, 45, 60, undefined];
      const selectedBudget =
        budgetChoices[
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
      const shouldReplan = decisionRandom(profile, day, 'daily-session', 'replan', 1) < 0.2;
      const shouldFocusDueReview =
        hadDueReviews && decisionRandom(profile, day, 'daily-session', 'due-review-focus', 1) < 0.3;
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
          const activityProgress = await readProgress(db, userId);
          const activityState = await new LearnerRepository(db, userId).schedulerState(
            now,
            activeContent,
          );
          auditSession(
            runtime,
            now,
            day,
            courseId,
            [activity],
            activityProgress,
            activityState,
            activeContent,
          );
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
          const newActivities = replanned.activities
            .filter((activity) => activity.status === 'planned')
            .map((activity, index) => {
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
            const activityProgress = await readProgress(db, userId);
            const activityState = await new LearnerRepository(db, userId).schedulerState(
              now,
              activeContent,
            );
            auditSession(
              runtime,
              now,
              day,
              courseId,
              [activity],
              activityProgress,
              activityState,
              activeContent,
            );
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
              const activityProgress = await readProgress(db, userId);
              const activityState = await new LearnerRepository(db, userId).schedulerState(
                now,
                activeContent,
              );
              auditSession(
                runtime,
                now,
                day,
                courseId,
                [activity],
                activityProgress,
                activityState,
                activeContent,
              );
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
            const activityProgress = await readProgress(db, userId);
            const activityState = await new LearnerRepository(db, userId).schedulerState(
              now,
              activeContent,
            );
            auditSession(
              runtime,
              now,
              day,
              courseId,
              [activity],
              activityProgress,
              activityState,
              activeContent,
            );
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
      if (!skip && !courseComplete && daily.lessons + daily.reviews === 0) {
        setP5EvidenceContext(runtime, day);
        addViolation(runtime, day, 'P5', courseId, [], {
          courseId,
          details: 'studied day had no lesson or review activity',
        });
      }
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
        const hasProgress = report.dailyStats
          .slice(-7)
          .some((item) => item.newTopicsCompleted > 0 || item.reviewAttempts > 0);
        if (!hasProgress) {
          setP5EvidenceContext(runtime, day);
          addViolation(runtime, day, 'P5', courseId, [], {
            courseId,
            details: `days ${firstDay}-${day} had no new topics or reviews`,
          });
        }
      }

      await reviewCardAudit(runtime, db, userId, now, day, timeZone, overdueReported);
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
  const startedAt = performance.now();
  const profiles: ProfileSimulationReport[] = [];
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    for (const profile of options.profiles) {
      options.onProgress?.(`Starting ${profile}`);
      profiles.push(await simulateProfile(db, content, options, profile));
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
  return `Day ${violation.day}: \`${violation.entityId}\`${context}${missing}${startable}${details}`;
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
    if (profile.profile === 'struggling') {
      const p5Violations = profile.violations.filter((item) => item.invariant === 'P5');
      if (p5Violations.length > 0) {
        lines.push('### P5 daily offers and course state', '');
        for (const violation of p5Violations) {
          const firstDay = Math.max(1, violation.day - 6);
          for (const daily of profile.dailyStats.filter(
            (item) =>
              item.day >= firstDay &&
              item.day <= violation.day &&
              item.courseId === violation.courseId,
          )) {
            const offers =
              daily.offers
                .map((offer) => {
                  const id = offer.conceptId ?? offer.projectId ?? offer.paperId;
                  const reviewTopics = offer.reviewTopics
                    ?.map((topic) => topic.conceptId)
                    .join(', ');
                  return id
                    ? `${offer.kind} ${id}`
                    : reviewTopics
                      ? `${offer.kind} ${reviewTopics}`
                      : offer.kind;
                })
                .join('; ') || 'no session activities';
            lines.push(`- Day ${daily.day} (${daily.courseId ?? 'no course'}): ${offers}.`);
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
