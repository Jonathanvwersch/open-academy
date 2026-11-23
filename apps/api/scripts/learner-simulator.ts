import type { CourseCatalogPayload, CoursePayload, LearnPayload } from '@academy/contracts/course';
import type { SessionActivity, TodayPayload } from '@academy/contracts/sessions';
import { and, eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import type { ContentEdge, ContentIndex } from '../src/content/types.js';
import type { Database } from '../src/db/client.js';
import {
  diagnosticRuns,
  lessonQuizAttempts,
  lessonQuizItems,
  lessonRuns,
  mastery,
  reviewCards,
  users,
} from '../src/db/schema.js';
import { masteryKey, prerequisiteMet } from '../src/learning/prerequisites.js';
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
] as const;

export type SimulationProfile = (typeof simulationProfiles)[number];
export type InvariantId = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7';

export interface SimulationViolation {
  profile: SimulationProfile;
  day: number;
  invariant: InvariantId;
  entityId: string;
  courseId?: string;
  conceptId?: string;
  projectId?: string;
  missingAncestors: string[];
  details?: string;
}

export interface DailySimulationStats {
  day: number;
  date: string;
  courseId: string | null;
  studied: boolean;
  lessons: number;
  reviews: number;
  reviewAttempts: number;
  newTopicsCompleted: number;
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
  totals: {
    lessonsPerDayMean: number;
    lessonsPerDayMax: number;
    reviewsPerDayMean: number;
    reviewsPerDayMax: number;
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

interface SimActivity extends SessionActivity {
  projectId?: string;
  paperId?: string;
}

interface LearnerProgress {
  masteryByKey: Map<string, { state: MasteryState; inferred: boolean }>;
  lessonRuns: Array<{
    conceptId: string;
    status: 'in_progress' | 'needs_retry' | 'quiz' | 'completed';
  }>;
  placedOut: Set<string>;
}

interface ProfileRuntime {
  profile: SimulationProfile;
  seed: number;
  rng: () => number;
  report: ProfileSimulationReport;
  violationKeys: Set<string>;
  offeredProjectKeys: Set<string>;
  lastPracticed: Map<string, number>;
  answered: number;
  wrongAnswers: number;
}

const graphRemovedConcepts = new Set([
  'inverses-linear-systems',
  'rank-span',
  'orthogonality-projections',
]);
const graphCourseId = 'maths-for-ml';
const graphMilestoneConceptId = 'eigen-svd';
const invariants: InvariantId[] = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'];

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

  constructor(
    private readonly db: Database,
    private content: ContentIndex,
    private readonly timeZone: string,
    initialNow: Date,
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
    const headers = new Headers({
      'X-Now': now.toISOString(),
      'X-Time-Zone': this.timeZone,
    });
    if (this.cookie) headers.set('cookie', this.cookie);
    if (body !== undefined) headers.set('content-type', 'application/json');
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
    return { ok: response.ok, status: response.status, data };
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
  const [masteryRows, runs, placements] = await Promise.all([
    db.select().from(mastery).where(eq(mastery.userId, userId)),
    db.select().from(lessonRuns).where(eq(lessonRuns.userId, userId)),
    db
      .select({ state: diagnosticRuns.state })
      .from(diagnosticRuns)
      .where(
        and(
          eq(diagnosticRuns.userId, userId),
          eq(diagnosticRuns.kind, 'placement'),
          eq(diagnosticRuns.status, 'completed'),
        ),
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
    lessonRuns: runs.map(({ conceptId, status }) => ({ conceptId, status })),
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
  fields: Pick<SimulationViolation, 'courseId' | 'conceptId' | 'projectId' | 'details'> = {},
) {
  const key = `${day}|${invariant}|${entityId}|${fields.details ?? ''}`;
  if (runtime.violationKeys.has(key)) return;
  runtime.violationKeys.add(key);
  runtime.report.violations.push({
    profile: runtime.profile,
    day,
    invariant,
    entityId,
    missingAncestors,
    ...fields,
  });
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
    if (topic.hasLesson && topic.status !== 'locked' && topic.status !== 'complete') {
      checkLessonReadiness(runtime, day, courseId, [topic.conceptId], progress, content);
    }
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
      checkProjectReadiness(runtime, day, unit.project.id, courseId, progress, content);
    }
  }
}

function auditHome(
  runtime: ProfileRuntime,
  day: number,
  courseId: string | undefined,
  today: TodayPayload,
  learn: LearnPayload,
  progress: LearnerProgress,
  content: ContentIndex,
) {
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
  const upcomingLessons = list(object(learn.upNext).upcoming)
    .map((item) => text(object(item).conceptId))
    .filter((conceptId): conceptId is string => Boolean(conceptId));
  const choices = learn.choices.map((choice) => choice.conceptId);
  checkLessonReadiness(
    runtime,
    day,
    courseId,
    [...plannedLessons, ...taskLessons, ...upcomingLessons, ...choices],
    progress,
    content,
  );
  for (const activity of planActivities) {
    if (activity.projectId) {
      checkProjectReadiness(runtime, day, activity.projectId, courseId, progress, content);
      if (courseId) offerProject(runtime, day, courseId, activity.projectId);
    }
  }
  for (const task of learn.tasks) {
    if (task.label === 'Project' && content.projectsById.has(task.id)) {
      checkProjectReadiness(runtime, day, task.id, courseId, progress, content);
      if (courseId) offerProject(runtime, day, courseId, task.id);
    }
  }
  const nextProject = object(object(learn.upNext).project);
  const projectId = text(nextProject.projectId) ?? text(nextProject.id);
  if (projectId) {
    checkProjectReadiness(runtime, day, projectId, courseId, progress, content);
    if (courseId) offerProject(runtime, day, courseId, projectId);
  }
}

function auditSession(
  runtime: ProfileRuntime,
  day: number,
  courseId: string,
  activities: SimActivity[],
  progress: LearnerProgress,
  content: ContentIndex,
) {
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

function answerForProfile(
  content: ContentIndex,
  exerciseId: string,
  seed: number,
  correct: boolean,
): unknown {
  const exercise = exerciseFor(content, exerciseId, seed);
  const answer = correct
    ? answerFor(content, exerciseId, seed)
    : wrongAnswerFor(content, exerciseId, seed);
  if (exercise.type !== 'explain') return answer;
  const answerObject = object(answer);
  return {
    text: text(answerObject.text) ?? 'A correct explanation.',
    metCriteria: correct ? exercise.rubric.map((item) => item.id) : [],
  };
}

function wantsCorrect(runtime: ProfileRuntime, conceptId: string, day: number): boolean {
  return runtime.rng() < profileAccuracy(runtime.profile, conceptId, day, runtime.lastPracticed);
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
  const cards = await db.select().from(reviewCards).where(eq(reviewCards.userId, userId));
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
    .where(eq(lessonQuizItems.quizAttemptId, lastAttempt.id));
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
  const intendedCorrect = wantsCorrect(runtime, problemConceptId, day);
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
  return object(result.run);
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
  for (let turn = 0; turn < 300; turn += 1) {
    const status = text(run.status);
    if (status === 'quiz' || status === 'completed') return run;
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
      await answerLessonProblem(
        api,
        content,
        runtime,
        now,
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
      const intendedCorrect = wantsCorrect(runtime, questionConceptId, day);
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
  const intendedCorrect = wantsCorrect(runtime, conceptId, day);
  const answer = answerForProfile(content, exerciseId, 0, intendedCorrect);
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
  const correct = numeric(object(response.data).correct, intendedCorrect ? 1 : 0);
  recordOutcome(runtime, conceptId, day, correct);
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
        .limit(1);
      if (finalRun[0]?.status === 'completed') {
        await completeActivity(api, now, sessionId, activity, {
          lessonViewed: true,
          lessonRunnerContinued: true,
        });
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
    for (const exerciseId of exerciseIds) {
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
    await completeActivity(api, now, sessionId, activity);
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
    .limit(1);
  if (run?.status !== 'completed') return graphContent;

  api.setContent(realContent);
  runtime.report.graphChangeDay = day;
  const progress = await readProgress(db, api.userId ?? '');
  const [today, learn, page] = await Promise.all([
    api.require<TodayPayload>('GET', '/today', now),
    api.require<LearnPayload>('GET', '/learn', now),
    fetchCoursePage(api, now, graphCourseId),
  ]);
  auditHome(runtime, day, courseId, today, learn, progress, realContent);
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

function summarizeDailyStats(stats: DailySimulationStats[]) {
  const mean = (values: number[]) =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    lessonsPerDayMean: mean(stats.map((item) => item.lessons)),
    lessonsPerDayMax: Math.max(0, ...stats.map((item) => item.lessons)),
    reviewsPerDayMean: mean(stats.map((item) => item.reviews)),
    reviewsPerDayMax: Math.max(0, ...stats.map((item) => item.reviews)),
  };
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
  const rng = seededRandom(seed);
  const originalRandom = Math.random;
  Math.random = rng;
  const graphContent = toGraphChangeContent(realContent);
  const initialContent = profile === 'graph-change' ? graphContent : realContent;
  const firstNow = localNoon(startDate, timeZone);
  const api = new SimulatedApi(db, initialContent, timeZone, firstNow);
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
    totals: {
      lessonsPerDayMean: 0,
      lessonsPerDayMax: 0,
      reviewsPerDayMean: 0,
      reviewsPerDayMax: 0,
      answers: 0,
      wrongAnswers: 0,
      wrongPercent: 0,
    },
    violationCounts: getViolationCounts([]),
    violations: [],
  };
  const runtime: ProfileRuntime = {
    profile,
    seed,
    rng,
    report,
    violationKeys: new Set(),
    offeredProjectKeys: new Set(),
    lastPracticed: new Map(),
    answered: 0,
    wrongAnswers: 0,
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

      const [today, learn] = await Promise.all([
        api.require<TodayPayload>('GET', '/today', now),
        api.require<LearnPayload>('GET', '/learn', now),
      ]);
      const userId = api.userId;
      if (!userId) throw new Error('Simulation API did not create a learner');
      const progress = await readProgress(db, userId);
      auditHome(runtime, day, courseId, today, learn, progress, activeContent);
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
        newTopicsCompleted: 0,
      };
      if (!skip) {
        const session = object(
          await api.require('POST', '/sessions', now, { kind: today.sessionKind }),
        );
        const sessionId = text(session.id);
        if (!sessionId) throw new Error('Session start did not return an id');
        const paperId = pageBefore.units
          .find((unit) => unit.unit === pageBefore.currentUnit)
          ?.papers.find((paper) => paper.status !== 'completed')?.id;
        const activities = list(session.activities).map((activity) => {
          const parsed = object(activity) as unknown as SimActivity;
          return parsed.kind === 'paper' && paperId ? { ...parsed, paperId } : parsed;
        });
        auditSession(runtime, day, courseId, activities, progress, activeContent);
        for (const activity of activities) {
          const result = await processActivity(
            api,
            db,
            activeContent,
            runtime,
            now,
            day,
            courseId,
            sessionId,
            activity,
          );
          daily.lessons += result.lessons;
          daily.reviews += result.reviews;
          daily.reviewAttempts += result.reviewAttempts;
        }
        await api.require('POST', `/sessions/${sessionId}/end`, now);
      }
      const pageAfter = await fetchCoursePage(api, now, courseId);
      daily.newTopicsCompleted = newTopicsCompleted(pageBefore, pageAfter);
      report.dailyStats.push(daily);

      const afterStudyCatalog = await fetchCourseCatalog(api, now);
      const currentCourse = courseRows(afterStudyCatalog).find((course) => course.id === courseId);
      const courseComplete = currentCourse ? isCourseComplete(currentCourse) : false;
      if (!skip && !courseComplete && daily.lessons + daily.reviews === 0) {
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
    report.violationCounts = getViolationCounts(report.violations);
    return report;
  } finally {
    await api.cleanup();
    Math.random = originalRandom;
  }
}

export async function simulateLearners(
  db: Database,
  content: ContentIndex,
  options: LearnerSimulationOptions,
): Promise<LearnerSimulationReport> {
  const startedAt = performance.now();
  const profiles: ProfileSimulationReport[] = [];
  for (const profile of options.profiles) {
    options.onProgress?.(`Starting ${profile}`);
    profiles.push(await simulateProfile(db, content, options, profile));
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
  const context = violation.courseId ? ` in ${violation.courseId}` : '';
  const details = violation.details ? ` (${violation.details})` : '';
  return `Day ${violation.day}: \`${violation.entityId}\`${context}${missing}${details}`;
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
    '| Profile | Courses finished | Days simulated | Lessons/day mean / max | Reviews/day mean / max | Wrong |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...report.profiles.map(
      (profile) =>
        `| ${profile.profile} | ${profile.courses.filter((course) => course.finishedDay !== null).length}/${profile.courses.length} | ${profile.daysSimulated} | ${profile.totals.lessonsPerDayMean.toFixed(2)} / ${profile.totals.lessonsPerDayMax} | ${profile.totals.reviewsPerDayMean.toFixed(2)} / ${profile.totals.reviewsPerDayMax} | ${profile.totals.wrongPercent.toFixed(1)}% |`,
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
      `Wrong answers: ${profile.totals.wrongAnswers}/${profile.totals.answers} (${profile.totals.wrongPercent.toFixed(1)}%).`,
      '',
      '### Violations',
      '',
      '| Invariant | Count |',
      '| --- | ---: |',
      ...invariants.map((invariant) => `| ${invariant} | ${profile.violationCounts[invariant]} |`),
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
