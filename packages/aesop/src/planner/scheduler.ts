import type { Card } from 'ts-fsrs';
import { Rating, State } from 'ts-fsrs';
import { orderCourseIdsBySubject } from '../course/course-order.js';
import { subjectForCourse } from '../course/index.js';
import { isTemplate } from '../course/templates.js';
import type {
  ContentIndex,
  IndexedConcept,
  IndexedCourse,
  IndexedExercise,
} from '../course/types.js';
import { buildEncompassingIndex } from '../graph/encompassing.js';
import {
  activeCourseFor,
  compareOutlinePosition,
  courseConceptIds,
  courseFoundationIds,
  courseUnitPositions,
  createPrerequisiteChecker,
  masteryKey,
  prerequisiteMet,
  projectReady,
} from '../graph/prerequisites.js';
import { isLessonRetryReady } from '../lessons/lesson-retry.js';
import { isDueToday, retrievability, startOfNextCalendarDay } from '../memory/fsrs.js';
import { implicitRepetition } from '../memory/implicit-repetition.js';
import type { MasteryRecord } from '../memory/types.js';
import { masteryRank } from '../memory/types.js';
import { localDateKey } from '../progress/xp.js';
import type { SessionKind } from './session-budget.js';

export type { SessionKind, SessionPreferences } from './session-budget.js';
export { sessionBudget } from './session-budget.js';

export type ActivityKind =
  | 'review'
  | 'diagnostic'
  | 'learn'
  | 'practice'
  | 'remediate'
  | 'quick_check'
  | 'transfer'
  | 'lab'
  | 'reflect'
  | 'teachback'
  | 'mixed_quiz'
  | 'paper';

export const SCHEDULER_CONFIG = {
  weights: { goal: 1, week_fit: 1, project: 1, unlock: 1, gap: 1, review: 1, cost: 1 },
  weekday: {
    reviewBudgetRatio: 0.3,
    maxNewConcepts: 2,
    maxActivities: 6,
    mixedReviewTopics: 3,
  },
  repeatWindowDays: 7,
  consolidationMinutes: 5,
} as const;

const RETRY_OVERDUE_DAYS = 2;

export interface PriorityTerms {
  goal: number;
  week_fit: number;
  project: number;
  unlock: number;
  gap: number;
  review: number;
  cost: number;
}

export interface ActivityReason {
  courseId?: string;
  terms: PriorityTerms;
  summary: string;
}

export interface PlannedActivity {
  kind: ActivityKind;
  conceptId?: string | null;
  projectId?: string;
  exerciseIds: string[];
  plannedMinutes: number;
  reason: ActivityReason;
  status?: 'planned' | 'in_progress' | 'completed' | 'skipped';
}

export interface SchedulerState {
  topicSpeeds?: Record<string, number>;
  pendingQuiz?: { plannedMinutes: number };
  timezone?: string;
  activeCourseId: string | null;
  studyCourseIds: string[];
  focusSubjectId?: string;
  recentLearnMinutesByConcept: Record<string, number>;
  mastery: MasteryRecord[];
  cards: Array<{
    conceptId: string;
    dimension: MasteryRecord['dimension'];
    dueAt: string;
    fsrs?: Card;
    retrievability?: number;
  }>;
  reviewedTodayConceptIds: string[];
  completedReviewRatingsToday?: Array<{ conceptId: string; rating: number }>;
  recentAttempts: Array<{
    conceptId: string;
    exerciseId: string;
    dimension?: MasteryRecord['dimension'];
    correct: number;
    itemRole: string;
    createdAt: string;
  }>;
  recallAttempts?: Array<{
    exerciseId: string;
    correct: number;
    createdAt: string;
  }>;
  remediationFlags: Array<{
    conceptId: string;
    targetPrereqId?: string | null;
    status?: 'open' | 'resolved';
  }>;
  projectProgress: Array<{ projectId: string; status: string }>;
  completedPaperIds: string[];
  startDate: string;
  currentProjectId?: string;
  inProgressConceptId?: string;
  actualEstimateRatio?: number;
  usedExerciseIds?: string[];
  lessonRuns?: Array<{
    conceptId: string;
    status: 'in_progress' | 'needs_retry' | 'quiz' | 'completed';
    startedAt?: string | Date;
    retryAfter?: string | Date | null;
  }>;
}

export interface SessionPlan {
  activities: PlannedActivity[];
  reasons: ActivityReason[];
}

export interface Candidate {
  activity: PlannedActivity;
  score: number;
  adjustedMinutes: number;
  newConcept: boolean;
  remediation?: boolean;
  courseId?: string;
}

export type ReviewSelectionResult =
  | 'selected'
  | 'selected:overdue'
  | 'covered'
  | 'not_candidate:reviewedToday'
  | 'not_candidate:stub'
  | 'not_candidate:focusFilter'
  | 'not_candidate:noEligibleExercise'
  | 'not_candidate:excludedByReplan'
  | 'rejected:reviewMinuteCap'
  | 'rejected:budget'
  | 'rejected:maxActivities'
  | 'rejected:usesSelectedExercise'
  | 'rejected:selectedConceptConflict'
  | 'rejected:other';

export interface ReviewSelectionExplanation {
  conceptId: string;
  result: ReviewSelectionResult;
  coveringConceptId?: string;
  exerciseIds: string[];
  exerciseDimensions: string[];
  candidateMinutes?: number;
  selectionOrder?: number;
  reviewMinutes: number;
  reviewCap: number;
  usedMinutes: number;
  budget: number;
  plannedActivityCount: number;
}

type ReviewSelectionTrace = {
  results: Map<string, ReviewSelectionResult>;
  coveringConceptIds: Map<string, string>;
  exerciseIds: Map<string, string[]>;
  candidateMinutes: Map<string, number>;
  selectionOrder: string[];
  metrics: Map<
    string,
    Pick<
      ReviewSelectionExplanation,
      'reviewMinutes' | 'reviewCap' | 'usedMinutes' | 'budget' | 'plannedActivityCount'
    >
  >;
  finalMetrics?: Pick<
    ReviewSelectionExplanation,
    'reviewMinutes' | 'reviewCap' | 'usedMinutes' | 'budget' | 'plannedActivityCount'
  >;
};

interface SchedulerCourseContext {
  course: IndexedCourse;
  currentUnit: number;
  unitTitle: string;
  unitPositions: Map<string, number>;
  newConceptIds: Set<string>;
}

type SchedulerCourseContextState = Pick<
  SchedulerState,
  'activeCourseId' | 'studyCourseIds' | 'focusSubjectId' | 'mastery' | 'lessonRuns'
>;

const noTerms = (): PriorityTerms => ({
  goal: 0,
  week_fit: 0,
  project: 0,
  unlock: 0,
  gap: 0,
  review: 0,
  cost: 0,
});

function hasKnowledgePointLessonContent(conceptId: string, content: ContentIndex): boolean {
  return (content.lessonsByConcept.get(conceptId)?.knowledge_points?.length ?? 0) > 0;
}

function hasCoreExercise(
  conceptId: string,
  dimension: IndexedConcept['dimensions'][number],
  content: ContentIndex,
): boolean {
  return (content.exercisesByConcept.get(conceptId) ?? []).some(
    (exercise) =>
      exercise.dimension === dimension && (exercise.role === 'core' || exercise.role === 'check'),
  );
}

function lessonRetryEligible(state: SchedulerState, conceptId: string, now: Date): boolean {
  const run = state.lessonRuns?.find((candidate) => candidate.conceptId === conceptId);
  if (run?.status !== 'needs_retry' || !run.retryAfter) return false;
  const retryAfter = typeof run.retryAfter === 'string' ? new Date(run.retryAfter) : run.retryAfter;
  return (
    retryAfter <= now &&
    !(state.remediationFlags ?? []).some(
      (flag) =>
        flag.conceptId === conceptId && (flag.status === undefined || flag.status === 'open'),
    )
  );
}

export function lessonRetryOverdue(state: SchedulerState, conceptId: string, now: Date): boolean {
  const run = state.lessonRuns?.find((candidate) => candidate.conceptId === conceptId);
  if (!run?.retryAfter || !lessonRetryEligible(state, conceptId, now)) return false;
  const retryAfter = typeof run.retryAfter === 'string' ? new Date(run.retryAfter) : run.retryAfter;
  return now.getTime() - retryAfter.getTime() >= RETRY_OVERDUE_DAYS * 24 * 60 * 60 * 1_000;
}

export function isLearnableConcept(concept: IndexedConcept, content: ContentIndex): boolean {
  return (
    concept.status !== 'stub' &&
    (hasKnowledgePointLessonContent(concept.id, content) ||
      concept.dimensions.some((dimension) => hasCoreExercise(concept.id, dimension, content)))
  );
}

export function currentLearnerUnit(
  state: Pick<SchedulerState, 'activeCourseId' | 'mastery' | 'lessonRuns'>,
  content: ContentIndex,
): number {
  const course = activeCourseFor(content, state.activeCourseId);
  const units = course?.units;
  if (!units?.length) return 1;
  const masteryByKey = new Map(
    state.mastery.map((record) => [masteryKey(record.conceptId, record.dimension), record]),
  );
  const lessonRuns = state.lessonRuns ?? [];
  for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
    for (const conceptId of units[unitIndex]?.concepts ?? []) {
      const concept = content.conceptsById.get(conceptId);
      if (
        concept &&
        isLearnableConcept(concept, content) &&
        !prerequisiteMet(conceptId, masteryByKey, lessonRuns, content)
      ) {
        return unitIndex + 1;
      }
    }
  }
  for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
    for (const conceptId of units[unitIndex]?.concepts ?? []) {
      if (
        content.conceptsById.get(conceptId)?.status !== 'stub' &&
        !prerequisiteMet(conceptId, masteryByKey, lessonRuns, content)
      ) {
        return unitIndex + 1;
      }
    }
  }
  return units.length;
}

function schedulerCourseContexts(
  state: SchedulerCourseContextState,
  content: ContentIndex,
): SchedulerCourseContext[] {
  const focusSubjectId = effectiveFocusSubjectId(
    { focusSubjectId: state.focusSubjectId },
    state.studyCourseIds,
    content,
  );
  return orderCourseIdsBySubject(content, state.studyCourseIds)
    .filter(
      (courseId) => !focusSubjectId || subjectForCourse(content, courseId).id === focusSubjectId,
    )
    .flatMap((courseId) => {
      const context = schedulerCourseContextFor(state, content, courseId);
      return context ? [context] : [];
    });
}

export function schedulerRecentLearnMinutesBySubject(
  state: SchedulerCourseContextState & Pick<SchedulerState, 'recentLearnMinutesByConcept'>,
  content: ContentIndex,
): Record<string, number> {
  const coursesBySubject = groupSchedulerCoursesBySubject(
    schedulerCourseContexts(state, content),
    content,
  );
  return Object.fromEntries(recentLearnMinutesForSubjects(state, coursesBySubject));
}

function groupSchedulerCoursesBySubject(
  courseContexts: readonly SchedulerCourseContext[],
  content: ContentIndex,
): Map<string, SchedulerCourseContext[]> {
  const coursesBySubject = new Map<string, SchedulerCourseContext[]>();
  for (const course of courseContexts) {
    const subjectId = subjectForCourse(content, course.course.id).id;
    const group = coursesBySubject.get(subjectId) ?? [];
    group.push(course);
    coursesBySubject.set(subjectId, group);
  }
  return coursesBySubject;
}

function recentLearnMinutesForSubjects(
  state: Pick<SchedulerState, 'recentLearnMinutesByConcept'>,
  coursesBySubject: ReadonlyMap<string, SchedulerCourseContext[]>,
): Map<string, number> {
  const subjectRecentMinutes = new Map<string, number>();
  for (const [subjectId, courses] of coursesBySubject) {
    const conceptIds = new Set(courses.flatMap((course) => [...course.newConceptIds]));
    subjectRecentMinutes.set(
      subjectId,
      [...conceptIds].reduce(
        (sum, conceptId) => sum + (state.recentLearnMinutesByConcept[conceptId] ?? 0),
        0,
      ),
    );
  }
  return subjectRecentMinutes;
}

export function effectiveFocusSubjectId(
  prefs: { focusSubjectId?: unknown } | null | undefined,
  activeCourseIds: readonly string[],
  content: ContentIndex,
): string | null {
  const focus = prefs?.focusSubjectId;
  if (
    typeof focus !== 'string' ||
    !content.curriculum?.subjects?.some((subject) => subject.id === focus)
  ) {
    return null;
  }
  const activeSubjectIds = new Set(
    activeCourseIds
      .filter((courseId) => content.coursesById.has(courseId))
      .map((courseId) => subjectForCourse(content, courseId).id),
  );
  return activeSubjectIds.size > 1 && activeSubjectIds.has(focus) ? focus : null;
}

function schedulerCourseContextFor(
  state: SchedulerCourseContextState,
  content: ContentIndex,
  courseId: string,
): SchedulerCourseContext | undefined {
  const course = content.coursesById.get(courseId);
  if (!course) return undefined;
  const currentUnit = currentLearnerUnit({ ...state, activeCourseId: courseId }, content);
  return {
    course,
    currentUnit,
    unitTitle: course.units[currentUnit - 1]?.title ?? `Unit ${currentUnit}`,
    unitPositions: courseUnitPositions(content, courseId),
    newConceptIds: new Set([
      ...courseConceptIds(course),
      ...courseFoundationIds(content, courseId),
    ]),
  };
}

function fallbackCourseContext(
  state: SchedulerCourseContextState,
  content: ContentIndex,
  courseId?: string,
): SchedulerCourseContext | undefined {
  const fallbackId =
    courseId ??
    state.studyCourseIds[0] ??
    state.activeCourseId ??
    content.curriculum?.default_course ??
    content.courses[0]?.id;
  return fallbackId ? schedulerCourseContextFor(state, content, fallbackId) : undefined;
}

export function planSession(
  state: SchedulerState,
  content: ContentIndex,
  now: Date,
  budgetMinutes: number,
  _kind: SessionKind = 'weekday',
  excludedLearnConceptIds: ReadonlySet<string> = new Set(),
  excludedReviewConceptIds: ReadonlySet<string> = new Set(),
  options: { focusConceptId?: string } = {},
): SessionPlan {
  return packWeekday(
    state,
    content,
    now,
    budgetMinutes,
    excludedLearnConceptIds,
    excludedReviewConceptIds,
    undefined,
    options,
  );
}

function plannedQuiz(state: SchedulerState, budgetMinutes: number): PlannedActivity | undefined {
  if (!state.pendingQuiz || state.pendingQuiz.plannedMinutes > budgetMinutes) return undefined;
  return {
    kind: 'mixed_quiz',
    exerciseIds: [],
    plannedMinutes: state.pendingQuiz.plannedMinutes,
    reason: staticReason('Timed mixed quiz'),
  };
}

export function explainReviewSelection(
  state: SchedulerState,
  content: ContentIndex,
  now: Date,
  budgetMinutes: number,
  excludedReviewConceptIds: ReadonlySet<string> = new Set(),
  options: {
    focusConceptId?: string;
    excludedLearnConceptIds?: ReadonlySet<string>;
  } = {},
): ReviewSelectionExplanation[] {
  const trace: ReviewSelectionTrace = {
    results: new Map(),
    coveringConceptIds: new Map(),
    exerciseIds: new Map(),
    candidateMinutes: new Map(),
    selectionOrder: [],
    metrics: new Map(),
  };
  packWeekday(
    state,
    content,
    now,
    budgetMinutes,
    options.excludedLearnConceptIds ?? new Set(),
    excludedReviewConceptIds,
    trace,
    options,
  );
  const conceptIds = [
    ...new Set([
      ...state.cards
        .filter((card) => isDueToday(card.dueAt, now, state.timezone ?? 'UTC'))
        .map((card) => card.conceptId),
      ...trace.results.keys(),
    ]),
  ].sort();
  const reviewOrder = new Map(trace.selectionOrder.map((conceptId, index) => [conceptId, index]));
  return conceptIds.map((conceptId) => ({
    conceptId,
    result: trace.results.get(conceptId) ?? 'rejected:other',
    ...(trace.coveringConceptIds.has(conceptId)
      ? { coveringConceptId: trace.coveringConceptIds.get(conceptId) }
      : {}),
    exerciseIds: trace.exerciseIds.get(conceptId) ?? [],
    ...(trace.results.get(conceptId)?.startsWith('selected')
      ? { selectionOrder: reviewOrder.get(conceptId) }
      : {}),
    ...(trace.candidateMinutes.has(conceptId)
      ? { candidateMinutes: trace.candidateMinutes.get(conceptId) }
      : {}),
    exerciseDimensions: [
      ...new Set(
        (trace.exerciseIds.get(conceptId) ?? []).flatMap((exerciseId) => {
          const dimension = content.exercisesById.get(exerciseId)?.dimension;
          return dimension ? [dimension] : [];
        }),
      ),
    ],
    ...(trace.metrics.get(conceptId) ??
      trace.finalMetrics ?? {
        reviewMinutes: 0,
        reviewCap: Math.floor(budgetMinutes * SCHEDULER_CONFIG.weekday.reviewBudgetRatio),
        usedMinutes: 0,
        budget: Math.max(0, budgetMinutes),
        plannedActivityCount: 0,
      }),
  }));
}

export function replan(
  state: SchedulerState,
  content: ContentIndex,
  now: Date,
  remainingBudgetMinutes: number,
  existingActivities: PlannedActivity[],
  kind: SessionKind = 'weekday',
): SessionPlan {
  const inputs = replanInputs(state, content, existingActivities);
  const plan = planSession(
    inputs.state,
    content,
    now,
    remainingBudgetMinutes,
    kind,
    inputs.excludedLearnConceptIds,
    inputs.coveredReviewConceptIds,
  );
  return {
    activities: [...inputs.inProgress, ...plan.activities],
    reasons: [...inputs.inProgress.map((activity) => activity.reason), ...plan.reasons],
  };
}

export function explainReviewSelectionForReplan(
  state: SchedulerState,
  content: ContentIndex,
  now: Date,
  remainingBudgetMinutes: number,
  existingActivities: PlannedActivity[],
) {
  const inputs = replanInputs(state, content, existingActivities);
  return {
    budget: remainingBudgetMinutes,
    excludedLearnConceptIds: [...inputs.excludedLearnConceptIds],
    coveredReviewConceptIds: [...inputs.coveredReviewConceptIds],
    usedExerciseIds: [...(inputs.state.usedExerciseIds ?? [])],
    results: explainReviewSelection(
      inputs.state,
      content,
      now,
      remainingBudgetMinutes,
      inputs.coveredReviewConceptIds,
      { excludedLearnConceptIds: inputs.excludedLearnConceptIds },
    ),
  };
}

function replanInputs(
  state: SchedulerState,
  content: ContentIndex,
  existingActivities: PlannedActivity[],
) {
  const inProgress = existingActivities.filter(
    (activity) =>
      activity.status === 'in_progress' &&
      (!activity.conceptId || content.conceptsById.get(activity.conceptId)?.status !== 'stub'),
  );
  const completed = existingActivities.filter((activity) => activity.status === 'completed');
  const coveredReviewConceptIds = new Set(
    existingActivities
      .filter(
        (activity) =>
          activity.kind === 'review' &&
          ['in_progress', 'completed', 'skipped'].includes(activity.status ?? ''),
      )
      .flatMap((activity) =>
        activity.exerciseIds.flatMap((exerciseId) => {
          const conceptId = content.exercisesById.get(exerciseId)?.concept;
          return conceptId ? [conceptId] : [];
        }),
      ),
  );
  const usedExerciseIds = [
    ...(state.usedExerciseIds ?? []),
    ...inProgress.flatMap((activity) => activity.exerciseIds),
    ...completed.flatMap((activity) => activity.exerciseIds),
  ];
  const excludedLearnConceptIds = new Set(
    existingActivities.flatMap((activity) =>
      activity.kind === 'learn' &&
      (activity.status === 'in_progress' || activity.status === 'completed') &&
      activity.conceptId
        ? [activity.conceptId]
        : [],
    ),
  );
  return {
    state: {
      ...state,
      usedExerciseIds,
      pendingQuiz: [...inProgress, ...completed].some((activity) => activity.kind === 'mixed_quiz')
        ? undefined
        : (state.pendingQuiz ??
          existingActivities.find(
            (activity) => activity.kind === 'mixed_quiz' && activity.status === 'planned',
          )),
    },
    inProgress,
    excludedLearnConceptIds,
    coveredReviewConceptIds,
  };
}

function shiftLocalDateKey(localDate: string, days: number) {
  const date = new Date(`${localDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

interface DueTopicCoverageContext {
  weights: ReturnType<typeof buildEncompassingIndex>;
  timezone: string;
  nextLocalDay: Date;
  dueCardsByConcept: Map<string, SchedulerState['cards']>;
  topicSpeeds: SchedulerState['topicSpeeds'];
}

function dueTopicCoverageContext(
  state: SchedulerState,
  content: ContentIndex,
  now: Date,
): DueTopicCoverageContext {
  const timezone = state.timezone ?? 'UTC';
  const dueCardsByConcept = new Map<string, SchedulerState['cards']>();
  for (const card of state.cards) {
    if (!isDueToday(card.dueAt, now, timezone)) continue;
    const dueCards = dueCardsByConcept.get(card.conceptId) ?? [];
    dueCards.push(card);
    dueCardsByConcept.set(card.conceptId, dueCards);
  }
  return {
    weights: buildEncompassingIndex(content),
    timezone,
    nextLocalDay: startOfNextCalendarDay(now, timezone),
    dueCardsByConcept,
    topicSpeeds: state.topicSpeeds,
  };
}

function dueTopicsCoveredByWithContext(
  taskConceptId: string,
  now: Date,
  context: DueTopicCoverageContext,
): Set<string> {
  const covered = new Set<string>();
  for (const [dueConceptId, dueCards] of context.dueCardsByConcept) {
    if (dueConceptId === taskConceptId) continue;
    const weight = context.weights.weight(taskConceptId, dueConceptId);
    if (weight <= 0) continue;
    if (
      dueCards.every((card) => {
        if (!card.fsrs) return false;
        const result = implicitRepetition(
          { fsrs: card.fsrs, dueAt: new Date(card.dueAt) },
          {
            weight,
            rating: Rating.Good,
            now,
            timeZone: context.timezone,
            enableFuzz: process.env.NODE_ENV !== 'test',
            speed: context.topicSpeeds?.[dueConceptId],
          },
        );
        return result !== undefined && result.dueAt >= context.nextLocalDay;
      })
    ) {
      covered.add(dueConceptId);
    }
  }
  return covered;
}

export function dueTopicsCoveredBy(
  taskConceptId: string,
  state: SchedulerState,
  content: ContentIndex,
  now: Date,
): Set<string> {
  return dueTopicsCoveredByWithContext(
    taskConceptId,
    now,
    dueTopicCoverageContext(state, content, now),
  );
}

export function learnLookAheadScore(
  conceptId: string,
  state: SchedulerState,
  content: ContentIndex,
  now: Date,
): number {
  const weights = buildEncompassingIndex(content);
  const enableFuzz = process.env.NODE_ENV !== 'test';
  return state.cards.reduce((total, card) => {
    if (!card.fsrs || card.conceptId === conceptId) return total;
    const weight = weights.weight(conceptId, card.conceptId);
    const update = implicitRepetition(
      { fsrs: card.fsrs, dueAt: new Date(card.dueAt) },
      {
        weight,
        rating: Rating.Good,
        now,
        timeZone: state.timezone ?? 'UTC',
        enableFuzz,
        speed: state.topicSpeeds?.[card.conceptId],
      },
    );
    return update ? total + weight * (1 - retrievability(card.fsrs, now, enableFuzz)) : total;
  }, 0);
}

function createManualFocusCandidate(
  state: SchedulerState,
  content: ContentIndex,
  conceptId: string,
): Candidate | undefined {
  const concept = content.conceptsById.get(conceptId);
  const lesson = content.lessonsByConcept.get(conceptId);
  const exercise = lesson?.final
    ? content.exercisesById.get(lesson.final)
    : content.exercisesByConcept
        .get(conceptId)
        ?.find((item) => item.role === 'core' || item.role === 'check');
  if (!concept || !exercise) return undefined;
  const priorEvidence = state.mastery.some(
    (record) =>
      record.conceptId === concept.id &&
      (record.inferred || masteryRank(record.state) >= masteryRank('assisted')),
  );
  const kind = lesson ? 'learn' : priorEvidence ? 'practice' : 'learn';
  const reason: ActivityReason = {
    terms: noTerms(),
    summary: 'Manual study override selected from the knowledge map.',
  };
  const plannedMinutes = exercise.est_minutes;
  return {
    activity: {
      kind,
      conceptId: concept.id,
      exerciseIds: [exercise.id],
      plannedMinutes,
      reason,
    },
    score: scoreTerms(reason.terms, plannedMinutes),
    adjustedMinutes: plannedMinutes,
    newConcept: kind === 'learn',
  };
}

function packWeekday(
  state: SchedulerState,
  content: ContentIndex,
  now: Date,
  sessionBudgetMinutes: number,
  excludedLearnConceptIds: ReadonlySet<string> = new Set(),
  excludedReviewConceptIds: ReadonlySet<string> = new Set(),
  reviewSelectionTrace?: ReviewSelectionTrace,
  options: { focusConceptId?: string } = {},
): SessionPlan {
  const focusConceptId = options.focusConceptId;
  const generatedCandidates = generateCandidates(state, content, now, reviewSelectionTrace);
  const focusAllowedLessonConcepts = new Set(
    (state.lessonRuns ?? [])
      .filter(
        (run) =>
          run.status === 'in_progress' ||
          run.status === 'quiz' ||
          (run.status === 'needs_retry' &&
            isLessonRetryReady(
              run.retryAfter ? new Date(run.retryAfter) : undefined,
              (state.remediationFlags ?? []).some(
                (flag) =>
                  flag.conceptId === run.conceptId &&
                  (flag.status === undefined || flag.status === 'open'),
              ),
              now,
            )),
      )
      .map((run) => run.conceptId),
  );
  const candidates = generatedCandidates.filter(
    (candidate) =>
      (candidate.activity.kind !== 'learn' ||
        (!excludedLearnConceptIds.has(candidate.activity.conceptId ?? '') &&
          (!focusConceptId ||
            candidate.activity.conceptId === focusConceptId ||
            focusAllowedLessonConcepts.has(candidate.activity.conceptId ?? '')))) &&
      (candidate.activity.kind !== 'review' ||
        !excludedReviewConceptIds.has(candidate.activity.conceptId ?? '')),
  );
  for (const candidate of generatedCandidates) {
    const conceptId = candidate.activity.conceptId;
    if (
      candidate.activity.kind === 'review' &&
      conceptId &&
      excludedReviewConceptIds.has(conceptId)
    ) {
      reviewSelectionTrace?.results.set(conceptId, 'not_candidate:excludedByReplan');
    }
  }
  const focusCandidate =
    focusConceptId === undefined
      ? undefined
      : (candidates.find(
          (candidate) =>
            candidate.activity.kind === 'learn' && candidate.activity.conceptId === focusConceptId,
        ) ?? createManualFocusCandidate(state, content, focusConceptId));
  const quiz = plannedQuiz(state, sessionBudgetMinutes - (focusCandidate?.adjustedMinutes ?? 0));
  const budget = Math.max(0, sessionBudgetMinutes - (quiz?.plannedMinutes ?? 0));
  const selected: Candidate[] = [];
  let usedMinutes = 0;
  let reviewMinutes = 0;
  const reviewCap = Math.floor(budget * SCHEDULER_CONFIG.weekday.reviewBudgetRatio);
  let newConceptCount = 0;
  const selectedConcepts = new Set<string>();
  const selectedLearnConcepts = new Set<string>();
  let learnBudget = budget;
  const reservedSlots = quiz ? 1 : 0;
  const plannedActivityCount = (items: Candidate[]) =>
    reservedSlots + mixReviewActivities(items, content).length;
  const addRejectionReason = (candidate: Candidate) => {
    const reviewAlongsideLesson =
      candidate.activity.kind === 'review' &&
      Boolean(candidate.activity.conceptId) &&
      selected.some(
        (selectedCandidate) =>
          selectedCandidate.activity.kind === 'learn' &&
          selectedCandidate.activity.conceptId === candidate.activity.conceptId,
      );
    if (plannedActivityCount([...selected, candidate]) > SCHEDULER_CONFIG.weekday.maxActivities)
      return 'maxActivities' as const;
    if (usedMinutes + candidate.adjustedMinutes > budget) return 'budget' as const;
    if (usesSelectedExercise(candidate, selected)) return 'usesSelectedExercise' as const;
    if (
      candidate.activity.conceptId &&
      selectedConcepts.has(candidate.activity.conceptId) &&
      !reviewAlongsideLesson
    )
      return 'selectedConceptConflict' as const;
    return undefined;
  };
  const metrics = () => ({
    reviewMinutes,
    reviewCap,
    usedMinutes,
    budget,
    plannedActivityCount: plannedActivityCount(selected),
  });
  const recordReviewResult = (
    conceptId: string,
    result: ReviewSelectionResult,
    candidate?: Candidate,
    coveringConceptId?: string,
  ) => {
    if (!reviewSelectionTrace) return;
    reviewSelectionTrace.results.set(conceptId, result);
    if (result === 'selected' || result === 'selected:overdue') {
      reviewSelectionTrace.selectionOrder.push(conceptId);
    }
    if (coveringConceptId) {
      reviewSelectionTrace.coveringConceptIds.set(conceptId, coveringConceptId);
    }
    if (candidate) {
      reviewSelectionTrace.exerciseIds.set(conceptId, candidate.activity.exerciseIds);
      reviewSelectionTrace.candidateMinutes.set(conceptId, candidate.adjustedMinutes);
    }
    reviewSelectionTrace.metrics.set(conceptId, metrics());
  };
  const add = (candidate: Candidate) => {
    if (addRejectionReason(candidate)) return false;
    selected.push(candidate);
    usedMinutes += candidate.adjustedMinutes;
    if (candidate.activity.conceptId) selectedConcepts.add(candidate.activity.conceptId);
    if (candidate.activity.kind === 'learn' && candidate.activity.conceptId) {
      selectedLearnConcepts.add(candidate.activity.conceptId);
    }
    return true;
  };
  const canAdd = (candidate: Candidate) => addRejectionReason(candidate) === undefined;
  const timezone = state.timezone ?? 'UTC';
  const localToday = localDateKey(now, timezone);
  const coverageContext = dueTopicCoverageContext(state, content, now);
  const dueConceptIds = new Set(coverageContext.dueCardsByConcept.keys());
  const dueTopicsLeftAfterLowCreditReviews = new Map<string, Set<string>>();
  for (const { conceptId, rating } of state.completedReviewRatingsToday ?? []) {
    if (rating >= Rating.Good) continue;
    const dueTopics = dueTopicsLeftAfterLowCreditReviews.get(conceptId) ?? new Set<string>();
    for (const dueConceptId of dueTopicsCoveredByWithContext(conceptId, now, coverageContext)) {
      dueTopics.add(dueConceptId);
    }
    dueTopicsLeftAfterLowCreditReviews.set(conceptId, dueTopics);
  }
  const dueTopicsByTaskConcept = new Map<string, Set<string>>();
  const hasKeptLessonRun = (conceptId: string) =>
    state.lessonRuns?.some(
      (run) =>
        run.conceptId === conceptId &&
        (run.status === 'in_progress' || run.status === 'quiz' || run.status === 'needs_retry'),
    ) ?? false;
  const learnTaskCanCoverDueReviews = (conceptId: string) =>
    !state.inProgressConceptId ||
    state.inProgressConceptId === conceptId ||
    hasKeptLessonRun(conceptId);
  const coveredByTaskConcept = (conceptId: string) => {
    let covered = dueTopicsByTaskConcept.get(conceptId);
    if (!covered) {
      covered = dueTopicsCoveredByWithContext(conceptId, now, coverageContext);
      for (const dueConceptId of dueTopicsLeftAfterLowCreditReviews.get(conceptId) ?? []) {
        covered.delete(dueConceptId);
      }
      dueTopicsByTaskConcept.set(conceptId, covered);
    }
    return covered;
  };
  const learnLookAheadScores = new Map<string, number>();
  const lookAheadScore = (conceptId: string) => {
    let score = learnLookAheadScores.get(conceptId);
    if (score === undefined) {
      score = learnLookAheadScore(conceptId, state, content, now);
      learnLookAheadScores.set(conceptId, score);
    }
    return score;
  };
  const lessonConceptsStartedToday = new Set(
    (state.lessonRuns ?? []).flatMap((run) => {
      if (!run.startedAt) return [];
      const startedAt = typeof run.startedAt === 'string' ? new Date(run.startedAt) : run.startedAt;
      return localDateKey(startedAt, timezone) === localToday ? [run.conceptId] : [];
    }),
  );
  const interferesWithLearn = (candidate: Candidate) => {
    const conceptId = candidate.activity.conceptId;
    if (candidate.activity.kind !== 'learn' || !conceptId) return false;
    for (const confusableId of content.confusablesById.get(conceptId) ?? []) {
      if (selectedLearnConcepts.has(confusableId) || lessonConceptsStartedToday.has(confusableId)) {
        return true;
      }
    }
    return false;
  };
  const canSelectLearn = (candidate: Candidate) =>
    canAdd(candidate) &&
    usedMinutes + candidate.adjustedMinutes <= learnBudget &&
    !interferesWithLearn(candidate);
  const resumedLessonConcepts = new Set(
    (state.lessonRuns ?? [])
      .filter((run) => run.status === 'in_progress' || run.status === 'quiz')
      .map((run) => run.conceptId),
  );
  const retryEligibleLessonConcepts = new Set(
    (state.lessonRuns ?? [])
      .filter((run) => lessonRetryEligible(state, run.conceptId, now))
      .map((run) => run.conceptId),
  );
  const overdueRetryLessonConcepts = new Set(
    [...retryEligibleLessonConcepts].filter((conceptId) =>
      lessonRetryOverdue(state, conceptId, now),
    ),
  );
  const haltedLessonConcepts = new Set(
    state.lessonRuns
      ?.filter(({ status }) => status === 'needs_retry')
      .map(({ conceptId }) => conceptId),
  );
  const haltedPrereqIds = new Set(
    state.remediationFlags.flatMap(({ conceptId, targetPrereqId, status }) =>
      status !== 'resolved' && targetPrereqId && haltedLessonConcepts.has(conceptId)
        ? [targetPrereqId]
        : [],
    ),
  );
  const priorityRemediation = new Set<Candidate>();
  let checkedPriorityRemediation = false;
  const unfinishedLessonConcepts = new Set([
    ...resumedLessonConcepts,
    ...retryEligibleLessonConcepts,
  ]);
  if (focusCandidate) {
    selected.push(focusCandidate);
    usedMinutes += focusCandidate.adjustedMinutes;
    if (focusCandidate.activity.conceptId) {
      selectedConcepts.add(focusCandidate.activity.conceptId);
      if (focusCandidate.activity.kind === 'learn') {
        selectedLearnConcepts.add(focusCandidate.activity.conceptId);
      }
    }
    if (focusCandidate.newConcept) newConceptCount += 1;
  }
  const courseContexts = schedulerCourseContexts(state, content);
  const courseOrder = new Map(courseContexts.map((course, index) => [course.course.id, index]));
  const compareLearnCandidates = (left: Candidate, right: Candidate) => {
    const leftInProgress = left.activity.conceptId === state.inProgressConceptId;
    const rightInProgress = right.activity.conceptId === state.inProgressConceptId;
    if (leftInProgress !== rightInProgress) return leftInProgress ? -1 : 1;
    const leftResumed = resumedLessonConcepts.has(left.activity.conceptId ?? '');
    const rightResumed = resumedLessonConcepts.has(right.activity.conceptId ?? '');
    if (leftResumed !== rightResumed) return leftResumed ? -1 : 1;
    const outlineOrder = compareOutlinePosition(
      left.activity.conceptId ?? '',
      right.activity.conceptId ?? '',
      content,
      left.courseId ?? state.activeCourseId,
    );
    const existingOrder =
      (courseOrder.get(left.courseId ?? '') ?? Infinity) -
        (courseOrder.get(right.courseId ?? '') ?? Infinity) ||
      outlineOrder ||
      right.score - left.score;
    if (existingOrder !== 0) return existingOrder;
    const leftConceptId = left.activity.conceptId ?? '';
    const rightConceptId = right.activity.conceptId ?? '';
    const leftFresh =
      left.newConcept &&
      !resumedLessonConcepts.has(leftConceptId) &&
      !retryEligibleLessonConcepts.has(leftConceptId);
    const rightFresh =
      right.newConcept &&
      !resumedLessonConcepts.has(rightConceptId) &&
      !retryEligibleLessonConcepts.has(rightConceptId);
    if (leftFresh && rightFresh) {
      return lookAheadScore(rightConceptId) - lookAheadScore(leftConceptId);
    }
    return 0;
  };
  for (const candidate of candidates
    .filter(
      (entry) =>
        entry.activity.kind === 'learn' &&
        entry.activity.conceptId &&
        (resumedLessonConcepts.has(entry.activity.conceptId) ||
          overdueRetryLessonConcepts.has(entry.activity.conceptId)),
    )
    .sort(compareLearnCandidates)) {
    if (newConceptCount >= SCHEDULER_CONFIG.weekday.maxNewConcepts) break;
    const conceptId = candidate.activity.conceptId;
    if (conceptId && overdueRetryLessonConcepts.has(conceptId) && !checkedPriorityRemediation) {
      checkedPriorityRemediation = true;
      for (const review of candidates
        .filter(
          ({ remediation, activity }) =>
            remediation && activity.conceptId && haltedPrereqIds.has(activity.conceptId),
        )
        .sort((left, right) => right.score - left.score)) {
        if (!add(review)) continue;
        priorityRemediation.add(review);
        reviewMinutes += review.adjustedMinutes;
        if (review.activity.conceptId)
          recordReviewResult(review.activity.conceptId, 'selected:overdue', review);
      }
    }
    const added =
      conceptId && overdueRetryLessonConcepts.has(conceptId)
        ? canSelectLearn(candidate) && add(candidate)
        : add(candidate);
    if (added) newConceptCount += 1;
  }
  const reviewCandidateDetails = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => candidate.activity.kind === 'review')
    .map((entry) => {
      const dimensions = new Set(
        entry.candidate.activity.exerciseIds.flatMap((exerciseId) => {
          const dimension = content.exercisesById.get(exerciseId)?.dimension;
          return dimension ? [dimension] : [];
        }),
      );
      const includedCards = state.cards.filter(
        (card) =>
          card.conceptId === entry.candidate.activity.conceptId &&
          dimensions.has(card.dimension) &&
          isDueToday(card.dueAt, now, timezone),
      );
      const earliestDueAt =
        includedCards.length > 0
          ? Math.min(...includedCards.map((card) => Date.parse(card.dueAt)))
          : undefined;
      const currentRetrievability =
        includedCards.length > 0
          ? Math.min(...includedCards.map((card) => card.retrievability ?? 0.9))
          : undefined;
      return {
        ...entry,
        earliestDueAt,
        currentRetrievability,
        overdue:
          entry.candidate.remediation === true ||
          (earliestDueAt !== undefined &&
            localDateKey(new Date(earliestDueAt), timezone) <= shiftLocalDateKey(localToday, -2)),
      };
    });
  const byUrgency = (
    left: (typeof reviewCandidateDetails)[number],
    right: (typeof reviewCandidateDetails)[number],
  ) =>
    right.candidate.activity.reason.terms.review - left.candidate.activity.reason.terms.review ||
    right.candidate.score - left.candidate.score ||
    left.index - right.index;
  const learnCandidates = candidates
    .filter((candidate) => candidate.activity.kind === 'learn')
    .filter((candidate) => candidate.activity.conceptId !== focusConceptId)
    .filter((candidate) => !unfinishedLessonConcepts.has(candidate.activity.conceptId ?? ''));
  const selectedLearnCoversDueConcept = (dueConceptId: string) =>
    selected.some(
      (candidate) =>
        candidate.activity.kind === 'learn' &&
        candidate.activity.conceptId &&
        learnTaskCanCoverDueReviews(candidate.activity.conceptId) &&
        coveredByTaskConcept(candidate.activity.conceptId).has(dueConceptId),
    );
  let reservedReviewMinutes = reviewMinutes;
  let reservedMinutes = 0;
  let fallbackReservation: Candidate | undefined;
  let fallbackReservationMinutes = 0;
  for (const detail of [...reviewCandidateDetails].sort(
    (left, right) =>
      right.candidate.activity.reason.terms.review - left.candidate.activity.reason.terms.review ||
      right.candidate.score - left.candidate.score ||
      left.index - right.index,
  )) {
    const candidate = detail.candidate;
    if (priorityRemediation.has(candidate)) continue;
    if (!candidate.remediation && !dueConceptIds.has(candidate.activity.conceptId ?? '')) {
      continue;
    }
    if (
      candidate.activity.conceptId &&
      selectedLearnCoversDueConcept(candidate.activity.conceptId)
    ) {
      continue;
    }
    const fitsReviewCap =
      candidate.remediation ||
      detail.overdue ||
      reservedReviewMinutes + candidate.adjustedMinutes <= reviewCap;
    if (fitsReviewCap && usedMinutes + reservedMinutes + candidate.adjustedMinutes <= budget) {
      reservedReviewMinutes += candidate.adjustedMinutes;
      reservedMinutes += candidate.adjustedMinutes;
    }
  }
  if (reservedReviewMinutes === 0) {
    fallbackReservation = [...reviewCandidateDetails]
      .filter(
        ({ candidate }) =>
          !candidate.remediation &&
          candidate.activity.conceptId &&
          dueConceptIds.has(candidate.activity.conceptId) &&
          !selectedLearnCoversDueConcept(candidate.activity.conceptId),
      )
      .sort(byUrgency)
      .find(
        ({ candidate }) => usedMinutes + reservedMinutes + candidate.adjustedMinutes <= budget,
      )?.candidate;
    if (fallbackReservation) {
      fallbackReservationMinutes = fallbackReservation.adjustedMinutes;
      reservedReviewMinutes += fallbackReservationMinutes;
      reservedMinutes += fallbackReservationMinutes;
    }
  }
  learnBudget = Math.max(0, budget - reservedMinutes);
  const reviewCoverageForConcept = (conceptId: string | null | undefined) => {
    if (!conceptId) return new Set<string>();
    const covered = new Set(coveredByTaskConcept(conceptId));
    if (dueConceptIds.has(conceptId)) covered.add(conceptId);
    return covered;
  };
  const canSelectWithFallbackReservation = (candidate: Candidate) => {
    const conceptId = candidate.activity.conceptId;
    const fallbackConceptId = fallbackReservation?.activity.conceptId;
    if (
      candidate.activity.kind !== 'learn' ||
      !conceptId ||
      !fallbackConceptId ||
      fallbackReservationMinutes <= 0
    ) {
      return false;
    }
    const fallbackCoverage = reviewCoverageForConcept(fallbackConceptId);
    const lessonCoverage = coveredByTaskConcept(conceptId);
    return (
      learnTaskCanCoverDueReviews(conceptId) &&
      [...fallbackCoverage].every((dueConceptId) => lessonCoverage.has(dueConceptId)) &&
      usedMinutes + candidate.adjustedMinutes <= learnBudget + fallbackReservationMinutes &&
      canAdd(candidate) &&
      !interferesWithLearn(candidate)
    );
  };
  const canSelectFreshLearn = (candidate: Candidate) =>
    !dueConceptIds.has(candidate.activity.conceptId ?? '') &&
    (canSelectLearn(candidate) || canSelectWithFallbackReservation(candidate));
  const releaseFallbackReservation = () => {
    reservedMinutes -= fallbackReservationMinutes;
    learnBudget += fallbackReservationMinutes;
    reservedReviewMinutes = 0;
    fallbackReservation = undefined;
    fallbackReservationMinutes = 0;
  };
  const candidatesByCourse = new Map<string, Candidate[]>();
  for (const candidate of learnCandidates) {
    if (!candidate.courseId) continue;
    const group = candidatesByCourse.get(candidate.courseId) ?? [];
    group.push(candidate);
    candidatesByCourse.set(candidate.courseId, group);
  }
  for (const group of candidatesByCourse.values()) group.sort(compareLearnCandidates);
  const eligibleCandidatesForCourse = (course: SchedulerCourseContext) =>
    (candidatesByCourse.get(course.course.id) ?? []).filter(canSelectFreshLearn);
  const coursesBySubject = groupSchedulerCoursesBySubject(courseContexts, content);
  const subjectOrder = new Map(
    (content.curriculum?.subjects ?? []).map((subject, position) => [subject.id, position]),
  );
  const selectedLearnMinutesBySubject = new Map<string, number>();
  const subjectRecentMinutes = recentLearnMinutesForSubjects(state, coursesBySubject);
  while (newConceptCount < SCHEDULER_CONFIG.weekday.maxNewConcepts) {
    const frontCourseBySubject = new Map<string, SchedulerCourseContext>();
    for (const [subjectId, courses] of coursesBySubject) {
      const frontCourse = courses.find((course) => eligibleCandidatesForCourse(course).length > 0);
      if (frontCourse) frontCourseBySubject.set(subjectId, frontCourse);
    }
    const nextSubject = [...frontCourseBySubject.keys()]
      .filter((subjectId) => {
        const course = frontCourseBySubject.get(subjectId);
        return course && eligibleCandidatesForCourse(course).length > 0;
      })
      .sort(
        (left, right) =>
          (subjectRecentMinutes.get(left) ?? 0) +
            (selectedLearnMinutesBySubject.get(left) ?? 0) -
            ((subjectRecentMinutes.get(right) ?? 0) +
              (selectedLearnMinutesBySubject.get(right) ?? 0)) ||
          (subjectOrder.get(left) ?? Infinity) - (subjectOrder.get(right) ?? Infinity),
      )[0];
    if (!nextSubject) break;
    const nextCourse = frontCourseBySubject.get(nextSubject);
    if (!nextCourse) break;
    const nextCandidates = candidatesByCourse.get(nextCourse.course.id) ?? [];
    const eligibleCandidates = eligibleCandidatesForCourse(nextCourse);
    const selectedUnits = new Set(
      selected.flatMap((selectedCandidate) => {
        const conceptId = selectedCandidate.activity.conceptId;
        if (
          selectedCandidate.activity.kind !== 'learn' ||
          selectedCandidate.courseId !== nextCourse.course.id ||
          !conceptId
        ) {
          return [];
        }
        const unit = nextCourse.unitPositions.get(conceptId);
        return unit === undefined ? [] : [unit];
      }),
    );
    const candidate =
      eligibleCandidates.find((entry) => {
        const conceptId = entry.activity.conceptId;
        const unit = conceptId ? nextCourse.unitPositions.get(conceptId) : undefined;
        return unit !== undefined && !selectedUnits.has(unit);
      }) ?? eligibleCandidates[0];
    if (!candidate) break;
    if (!canSelectLearn(candidate)) {
      if (!canSelectWithFallbackReservation(candidate)) break;
      releaseFallbackReservation();
    }
    if (!canSelectLearn(candidate) || !add(candidate)) break;
    newConceptCount += 1;
    selectedLearnMinutesBySubject.set(
      nextSubject,
      (selectedLearnMinutesBySubject.get(nextSubject) ?? 0) + candidate.activity.plannedMinutes,
    );
    nextCandidates.splice(nextCandidates.indexOf(candidate), 1);
  }

  for (const candidate of candidates
    .filter(
      (entry) =>
        entry.activity.kind === 'learn' &&
        entry.activity.conceptId &&
        retryEligibleLessonConcepts.has(entry.activity.conceptId) &&
        !overdueRetryLessonConcepts.has(entry.activity.conceptId),
    )
    .sort(compareLearnCandidates)) {
    if (newConceptCount >= SCHEDULER_CONFIG.weekday.maxNewConcepts) break;
    if (canSelectLearn(candidate) && add(candidate)) newConceptCount += 1;
  }

  const coveredBy = new Map<string, string>();
  for (const candidate of selected) {
    const taskConceptId = candidate.activity.conceptId;
    if (
      candidate.activity.kind !== 'learn' ||
      !taskConceptId ||
      !learnTaskCanCoverDueReviews(taskConceptId)
    ) {
      continue;
    }
    for (const dueConceptId of coveredByTaskConcept(taskConceptId)) {
      if (!coveredBy.has(dueConceptId)) coveredBy.set(dueConceptId, taskConceptId);
    }
  }

  const allReviewDetails = [...reviewCandidateDetails];
  const knownReviewConcepts = new Set(
    allReviewDetails.map(({ candidate }) => candidate.activity.conceptId),
  );
  for (const candidate of candidates) {
    const conceptId = candidate.activity.conceptId;
    if (
      candidate.activity.kind !== 'review' ||
      candidate.remediation ||
      !conceptId ||
      dueConceptIds.has(conceptId) ||
      knownReviewConcepts.has(conceptId)
    ) {
      continue;
    }
    const covered = coveredByTaskConcept(conceptId);
    if ([...covered].filter((dueId) => !coveredBy.has(dueId)).length < 2) continue;
    allReviewDetails.push({
      candidate,
      index: allReviewDetails.length + reviewCandidateDetails.length,
      earliestDueAt: undefined,
      currentRetrievability: undefined,
      overdue: false,
    });
    knownReviewConcepts.add(conceptId);
  }

  for (const dueConceptId of dueConceptIds) {
    const coveringConceptId = coveredBy.get(dueConceptId);
    const dueCandidate = reviewCandidateDetails.find(
      ({ candidate }) => candidate.activity.conceptId === dueConceptId,
    )?.candidate;
    if (coveringConceptId && dueCandidate && !dueCandidate.remediation) {
      recordReviewResult(dueConceptId, 'covered', dueCandidate, coveringConceptId);
    }
  }

  const uncoveredDueConcepts = new Set([...dueConceptIds].filter((id) => !coveredBy.has(id)));
  const reviewCoverage = (candidate: Candidate) =>
    reviewCoverageForConcept(candidate.activity.conceptId);
  const rankReviewDetails = (
    details: typeof reviewCandidateDetails,
    uncovered: ReadonlySet<string>,
  ) =>
    details
      .map((entry) => ({
        ...entry,
        newlyCovered: [...reviewCoverage(entry.candidate)].filter((id) => uncovered.has(id)).length,
      }))
      .sort((left, right) => {
        const remediationOrder =
          Number(right.candidate.remediation === true) -
          Number(left.candidate.remediation === true);
        if (remediationOrder !== 0) return remediationOrder;
        if (left.overdue !== right.overdue) return left.overdue ? -1 : 1;
        if (left.overdue && right.overdue) {
          return (
            (left.earliestDueAt ?? Infinity) - (right.earliestDueAt ?? Infinity) ||
            (left.currentRetrievability ?? Infinity) - (right.currentRetrievability ?? Infinity) ||
            left.index - right.index
          );
        }
        if (right.newlyCovered !== left.newlyCovered) return right.newlyCovered - left.newlyCovered;
        return byUrgency(left, right);
      });
  const candidatesToSelect = [...allReviewDetails];
  while (candidatesToSelect.length > 0) {
    const ranked = rankReviewDetails(candidatesToSelect, uncoveredDueConcepts);
    const next = ranked[0];
    if (!next) break;
    const candidate = next.candidate;
    const conceptId = candidate.activity.conceptId;
    const candidateIndex = candidatesToSelect.findIndex((entry) => entry.candidate === candidate);
    if (candidateIndex >= 0) candidatesToSelect.splice(candidateIndex, 1);
    if (!conceptId) continue;
    const covering = coveredBy.get(conceptId);
    if (covering && !candidate.remediation) {
      recordReviewResult(conceptId, 'covered', candidate, covering);
      continue;
    }
    if (candidate.remediation) {
      if (!priorityRemediation.has(candidate)) {
        const rejectionReason = addRejectionReason(candidate);
        if (rejectionReason) {
          recordReviewResult(conceptId, `rejected:${rejectionReason}`, candidate);
          continue;
        }
        if (!add(candidate)) continue;
        reviewMinutes += candidate.adjustedMinutes;
        recordReviewResult(conceptId, next.overdue ? 'selected:overdue' : 'selected', candidate);
      }
      for (const dueId of reviewCoverage(candidate)) {
        uncoveredDueConcepts.delete(dueId);
        coveredBy.set(dueId, conceptId);
      }
      continue;
    }
    if (!dueConceptIds.has(conceptId) && next.newlyCovered < 2) {
      recordReviewResult(conceptId, 'rejected:other', candidate);
      continue;
    }
    if (next.newlyCovered < 1) {
      recordReviewResult(conceptId, 'rejected:other', candidate);
      continue;
    }
    if (reviewMinutes + candidate.adjustedMinutes > reviewCap && !next.overdue) {
      recordReviewResult(conceptId, 'rejected:reviewMinuteCap', candidate);
      continue;
    }
    const rejectionReason = addRejectionReason(candidate);
    if (rejectionReason) {
      recordReviewResult(conceptId, `rejected:${rejectionReason}`, candidate);
      continue;
    }
    if (add(candidate)) {
      reviewMinutes += candidate.adjustedMinutes;
      recordReviewResult(conceptId, next.overdue ? 'selected:overdue' : 'selected', candidate);
      for (const dueId of reviewCoverage(candidate)) {
        uncoveredDueConcepts.delete(dueId);
        coveredBy.set(dueId, conceptId);
      }
    }
  }

  if (!selected.some((candidate) => candidate.activity.kind === 'review')) {
    const fallbackReview = [...reviewCandidateDetails]
      .filter(
        ({ candidate }) =>
          candidate.activity.conceptId &&
          dueConceptIds.has(candidate.activity.conceptId) &&
          uncoveredDueConcepts.has(candidate.activity.conceptId),
      )
      .sort(byUrgency)
      .find(({ candidate }) => canAdd(candidate))?.candidate;
    if (fallbackReview && add(fallbackReview)) {
      reviewMinutes += fallbackReview.adjustedMinutes;
      for (const dueId of reviewCoverage(fallbackReview)) {
        uncoveredDueConcepts.delete(dueId);
        if (fallbackReview.activity.conceptId) {
          coveredBy.set(dueId, fallbackReview.activity.conceptId);
        }
      }
      if (fallbackReview.activity.conceptId) {
        recordReviewResult(fallbackReview.activity.conceptId, 'selected', fallbackReview);
      }
    }
  }

  const otherCandidates = candidates
    .filter((candidate) => !['review', 'learn'].includes(candidate.activity.kind))
    .sort((left, right) => right.score - left.score);
  for (const candidate of otherCandidates) add(candidate);

  const taskCoversDueTopic = (candidate: Candidate, dueConceptId: string) => {
    const taskConceptId = candidate.activity.conceptId;
    if (!taskConceptId) return false;
    if (candidate.activity.kind === 'learn') {
      return (
        learnTaskCanCoverDueReviews(taskConceptId) &&
        coveredByTaskConcept(taskConceptId).has(dueConceptId)
      );
    }
    return candidate.activity.kind === 'review' && reviewCoverage(candidate).has(dueConceptId);
  };
  const pruneCoveredReviews = () => {
    for (const candidate of [...selected]) {
      if (
        candidate.activity.kind !== 'review' ||
        candidate.remediation ||
        !candidate.activity.conceptId
      ) {
        continue;
      }
      const dueTopics = reviewCoverage(candidate);
      if (dueTopics.size === 0) continue;
      const otherTasks = selected.filter((other) => other !== candidate);
      const coveringConceptByDueTopic = new Map<string, string>();
      for (const dueConceptId of dueTopics) {
        const coveringTask = otherTasks.find((other) => taskCoversDueTopic(other, dueConceptId));
        if (coveringTask?.activity.conceptId) {
          coveringConceptByDueTopic.set(dueConceptId, coveringTask.activity.conceptId);
        }
      }
      if (coveringConceptByDueTopic.size !== dueTopics.size) continue;
      const candidateIndex = selected.indexOf(candidate);
      if (candidateIndex < 0) continue;
      selected.splice(candidateIndex, 1);
      usedMinutes -= candidate.adjustedMinutes;
      reviewMinutes -= candidate.adjustedMinutes;
      const coveringConceptId =
        coveringConceptByDueTopic.get(candidate.activity.conceptId) ??
        coveringConceptByDueTopic.values().next().value;
      recordReviewResult(candidate.activity.conceptId, 'covered', candidate, coveringConceptId);
      return true;
    }
    return false;
  };
  const refreshUncoveredDueConcepts = () => {
    for (const dueConceptId of dueConceptIds) {
      if (selected.some((candidate) => taskCoversDueTopic(candidate, dueConceptId))) {
        uncoveredDueConcepts.delete(dueConceptId);
      } else {
        uncoveredDueConcepts.add(dueConceptId);
      }
    }
  };
  const dueReviewCandidates = reviewCandidateDetails.filter(
    ({ candidate }) =>
      candidate.activity.conceptId && dueConceptIds.has(candidate.activity.conceptId),
  );
  const recordCoveredDueTopic = (dueConceptId: string, coveringCandidate: Candidate) => {
    const coveringConceptId = coveringCandidate.activity.conceptId;
    if (!coveringConceptId || coveringConceptId === dueConceptId) return;
    const dueCandidate = dueReviewCandidates.find(
      ({ candidate }) => candidate.activity.conceptId === dueConceptId,
    )?.candidate;
    if (!dueCandidate) return;
    const latestResult = reviewSelectionTrace?.results.get(dueConceptId);
    if (latestResult === 'selected' || latestResult === 'selected:overdue') return;
    recordReviewResult(dueConceptId, 'covered', dueCandidate, coveringConceptId);
  };
  const recordCoveredDueTopicsFromSelected = () => {
    for (const dueConceptId of dueConceptIds) {
      const coveringCandidate = selected.find(
        (candidate) =>
          candidate.activity.conceptId !== dueConceptId &&
          taskCoversDueTopic(candidate, dueConceptId),
      );
      if (coveringCandidate) recordCoveredDueTopic(dueConceptId, coveringCandidate);
    }
  };
  while (pruneCoveredReviews()) {
    refreshUncoveredDueConcepts();
    recordCoveredDueTopicsFromSelected();
    const attempted = new Set<Candidate>();
    while (true) {
      const candidatesToRefill = dueReviewCandidates.filter(({ candidate }) => {
        const conceptId = candidate.activity.conceptId;
        return (
          conceptId &&
          !attempted.has(candidate) &&
          !selected.includes(candidate) &&
          uncoveredDueConcepts.has(conceptId) &&
          !selected.some((other) => taskCoversDueTopic(other, conceptId))
        );
      });
      const next = rankReviewDetails(candidatesToRefill, uncoveredDueConcepts)[0];
      if (!next) break;
      const candidate = next.candidate;
      const conceptId = candidate.activity.conceptId;
      if (!conceptId) break;
      attempted.add(candidate);
      if (
        !candidate.remediation &&
        reviewMinutes + candidate.adjustedMinutes > reviewCap &&
        !next.overdue
      ) {
        recordReviewResult(conceptId, 'rejected:reviewMinuteCap', candidate);
        continue;
      }
      const rejectionReason = addRejectionReason(candidate);
      if (rejectionReason) {
        recordReviewResult(conceptId, `rejected:${rejectionReason}`, candidate);
        continue;
      }
      if (!add(candidate)) continue;
      reviewMinutes += candidate.adjustedMinutes;
      recordReviewResult(conceptId, next.overdue ? 'selected:overdue' : 'selected', candidate);
      for (const dueId of reviewCoverage(candidate)) {
        uncoveredDueConcepts.delete(dueId);
        coveredBy.set(dueId, conceptId);
        recordCoveredDueTopic(dueId, candidate);
      }
    }
  }

  selected.sort((left, right) => {
    const priority = (candidate: Candidate) => {
      const conceptId = candidate.activity.conceptId ?? '';
      if (
        focusConceptId &&
        conceptId === focusConceptId &&
        (candidate.activity.kind === 'learn' || candidate.activity.kind === 'practice')
      ) {
        return -1;
      }
      if (candidate.activity.kind === 'learn' && resumedLessonConcepts.has(conceptId)) return 0;
      if (priorityRemediation.has(candidate)) return 1;
      if (candidate.activity.kind === 'learn' && overdueRetryLessonConcepts.has(conceptId))
        return 2;
      if (candidate.activity.kind === 'review') return 3;
      if (candidate.activity.kind === 'learn' && retryEligibleLessonConcepts.has(conceptId)) {
        return 5;
      }
      return candidate.activity.kind === 'learn' ? 4 : 6;
    };
    return priority(left) - priority(right);
  });
  const mixedReviewCandidates = mixReviewActivities(selected, content);
  const optionalActivities = optionalProjectAndPaperActivities(
    state,
    content,
    Math.max(0, budget - usedMinutes),
    reservedSlots + mixedReviewCandidates.length,
    selected.find((candidate) => candidate.activity.kind === 'learn')?.courseId,
  );
  const activities = [
    ...mixedReviewCandidates.map((candidate) => candidate.activity),
    ...optionalActivities,
  ];
  if (reviewSelectionTrace) {
    reviewSelectionTrace.finalMetrics = {
      ...metrics(),
      plannedActivityCount: reservedSlots + activities.length,
    };
  }
  const plan = quiz ? [quiz, ...activities] : activities;
  return { activities: plan, reasons: plan.map((activity) => activity.reason) };
}

export function mixReviewActivities(selected: Candidate[], content: ContentIndex): Candidate[] {
  const selectedLearnConcepts = new Set(
    selected.flatMap((candidate) =>
      candidate.activity.kind === 'learn' && candidate.activity.conceptId
        ? [candidate.activity.conceptId]
        : [],
    ),
  );
  const mergeableReviews = selected.flatMap((candidate, index) =>
    candidate.activity.kind === 'review' &&
    candidate.activity.conceptId &&
    !selectedLearnConcepts.has(candidate.activity.conceptId)
      ? [{ candidate, index }]
      : [],
  );
  if (mergeableReviews.length < 2) return selected;

  const reviewsByCourse = new Map<string, typeof mergeableReviews>();
  for (const review of [...mergeableReviews].sort(
    (left, right) => right.candidate.score - left.candidate.score || left.index - right.index,
  )) {
    const courseId = review.candidate.courseId ?? review.candidate.activity.reason.courseId ?? '';
    const courseReviews = reviewsByCourse.get(courseId) ?? [];
    courseReviews.push(review);
    reviewsByCourse.set(courseId, courseReviews);
  }

  const roundRobinReviews = [];
  while (true) {
    let addedReview = false;
    for (const courseReviews of reviewsByCourse.values()) {
      const review = courseReviews.shift();
      if (review) {
        roundRobinReviews.push(review);
        addedReview = true;
      }
    }
    if (!addedReview) break;
  }

  const groupCount = Math.ceil(
    roundRobinReviews.length / SCHEDULER_CONFIG.weekday.mixedReviewTopics,
  );
  const groupSize = Math.floor(roundRobinReviews.length / groupCount);
  const largerGroups = roundRobinReviews.length % groupCount;
  const mergedByReview = new Map<Candidate, Candidate>();
  let offset = 0;
  for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
    const size = groupSize + (groupIndex < largerGroups ? 1 : 0);
    const group = roundRobinReviews.slice(offset, offset + size);
    offset += size;
    const firstReview = group[0]?.candidate;
    if (!firstReview) continue;
    const reviews = group.map(({ candidate }) => candidate);
    const remediationReason = reviews.find(({ activity }) =>
      activity.reason.summary.includes(' before retrying '),
    )?.activity.reason.summary;
    const titles = reviews.map(
      ({ activity }) =>
        content.conceptsById.get(activity.conceptId ?? '')?.title ?? activity.conceptId ?? '',
    );
    const firstReason = firstReview.activity.reason;
    const merged: Candidate = {
      activity: {
        kind: 'review',
        conceptId: null,
        exerciseIds: interleaveReviewExercises(
          reviews.map(({ activity }) => ({
            topicId: activity.conceptId ?? '',
            exerciseIds: activity.exerciseIds,
          })),
        ),
        plannedMinutes: reviews.reduce(
          (minutes, review) => minutes + review.activity.plannedMinutes,
          0,
        ),
        reason: {
          terms: {
            ...firstReason.terms,
            review: Math.max(...reviews.map((review) => review.activity.reason.terms.review)),
          },
          summary: remediationReason ?? `Mixed review: ${titles.join(', ')}.`,
        },
      },
      score: Math.max(...reviews.map((review) => review.score)),
      adjustedMinutes: reviews.reduce((minutes, review) => minutes + review.adjustedMinutes, 0),
      newConcept: false,
    };
    for (const review of reviews) mergedByReview.set(review, merged);
  }

  const result: Candidate[] = [];
  const emitted = new Set<Candidate>();
  for (const candidate of selected) {
    const merged = mergedByReview.get(candidate);
    if (!merged) {
      result.push(candidate);
    } else if (!emitted.has(merged)) {
      result.push(merged);
      emitted.add(merged);
    }
  }
  return result;
}

export function interleaveReviewExercises(
  reviews: Array<{ topicId: string; exerciseIds: string[] }>,
): string[] {
  const exerciseIds: string[] = [];
  const remaining = reviews.map((review) => ({
    ...review,
    nextIndex: 0,
  }));
  let previousTopicId: string | undefined;
  while (remaining.some((review) => review.nextIndex < review.exerciseIds.length)) {
    const available = remaining
      .filter(
        (review) =>
          review.nextIndex < review.exerciseIds.length && review.topicId !== previousTopicId,
      )
      .sort(
        (left, right) =>
          right.exerciseIds.length - right.nextIndex - (left.exerciseIds.length - left.nextIndex) ||
          reviews.findIndex((review) => review.topicId === left.topicId) -
            reviews.findIndex((review) => review.topicId === right.topicId),
      );
    const selected =
      available[0] ??
      remaining
        .filter((review) => review.nextIndex < review.exerciseIds.length)
        .sort(
          (left, right) =>
            reviews.findIndex((review) => review.topicId === left.topicId) -
            reviews.findIndex((review) => review.topicId === right.topicId),
        )[0];
    if (!selected) break;
    const exerciseId = selected.exerciseIds[selected.nextIndex];
    if (exerciseId) exerciseIds.push(exerciseId);
    selected.nextIndex += 1;
    previousTopicId = selected.topicId;
  }
  return exerciseIds;
}

function generateCandidates(
  state: SchedulerState,
  content: ContentIndex,
  now: Date,
  reviewSelectionTrace?: ReviewSelectionTrace,
): Candidate[] {
  const candidates: Candidate[] = [];
  const courseContexts = schedulerCourseContexts(state, content);
  const focusSubjectId = effectiveFocusSubjectId(
    { focusSubjectId: state.focusSubjectId },
    state.studyCourseIds,
    content,
  );
  const newConceptIds = new Set(courseContexts.flatMap((course) => [...course.newConceptIds]));
  const masteryByKey = new Map(
    state.mastery.map((record) => [masteryKey(record.conceptId, record.dimension), record]),
  );
  const prerequisiteChecker = createPrerequisiteChecker(
    masteryByKey,
    state.lessonRuns ?? [],
    content,
  );
  const recentIds = new Set(
    state.recentAttempts
      .filter((attempt) => daysSince(attempt.createdAt, now) < SCHEDULER_CONFIG.repeatWindowDays)
      .map((attempt) => attempt.exerciseId),
  );
  for (const concept of courseContexts.length ? content.concepts : []) {
    if (concept.status === 'stub') {
      continue;
    }
    const states = concept.dimensions.map((dimension) =>
      masteryByKey.get(masteryKey(concept.id, dimension)),
    );
    const prereqsReady = prerequisiteChecker.chainReady(concept.id);
    const allNotAssessed = states.every((record) => !record || record.state === 'not_assessed');
    const isNew =
      newConceptIds.has(concept.id) &&
      prereqsReady &&
      (allNotAssessed || states.some((record) => record?.state === 'introduced'));
    const isContinuing =
      newConceptIds.has(concept.id) &&
      prereqsReady &&
      states.some((record) => record?.state === 'introduced' || record?.state === 'assisted');
    const hasKnowledgePointLesson = hasKnowledgePointLessonContent(concept.id, content);
    const lessonRun = state.lessonRuns?.find((run) => run.conceptId === concept.id);
    const lessonRunStatus = lessonRun?.status;
    const retryEligible = lessonRetryEligible(state, concept.id, now);
    if (lessonRunStatus === 'needs_retry' && !retryEligible) continue;
    const shouldResumeLesson =
      newConceptIds.has(concept.id) &&
      hasKnowledgePointLesson &&
      prereqsReady &&
      (lessonRunStatus === 'in_progress' ||
        (lessonRunStatus === 'needs_retry' && retryEligible) ||
        lessonRunStatus === 'quiz');
    const completedKnowledgePointLesson =
      hasKnowledgePointLesson && lessonRunStatus === 'completed';
    const courseContext =
      courseContexts.find((course) => course.newConceptIds.has(concept.id)) ?? courseContexts[0];
    if (!courseContext) continue;
    const projectId = courseContext.course.units[courseContext.currentUnit - 1]?.project;
    const project = projectId ? content.projectsById.get(projectId) : undefined;
    if (shouldResumeLesson) {
      const finalId = content.lessonsByConcept.get(concept.id)?.final;
      const exercise = finalId ? content.exercisesById.get(finalId) : undefined;
      if (exercise) {
        candidates.push(
          makeCandidate(
            state,
            content,
            concept,
            'learn',
            [exercise],
            courseContext,
            project,
            true,
            100,
          ),
        );
      }
    } else if (!completedKnowledgePointLesson && (isNew || isContinuing)) {
      const dimension = concept.dimensions.find((candidate) => {
        const state = masteryByKey.get(masteryKey(concept.id, candidate))?.state ?? 'not_assessed';
        const hasCoreItem = hasCoreExercise(concept.id, candidate, content);
        return (
          hasCoreItem &&
          (state === 'introduced' || state === 'assisted' || state === 'not_assessed')
        );
      });
      const exercise = hasKnowledgePointLesson
        ? content.exercisesById.get(content.lessonsByConcept.get(concept.id)?.final ?? '')
        : chooseExercise(state, content, concept, dimension, ['core', 'check'], now, recentIds);
      if (exercise) {
        candidates.push(
          makeCandidate(
            state,
            content,
            concept,
            isNew ? 'learn' : 'practice',
            [exercise],
            courseContext,
            project,
            isNew,
            isNew ? 0 : 1,
          ),
        );
      }
    }
  }

  const dueCardsByConcept = collectDueReviewCards(
    state,
    content,
    now,
    focusSubjectId,
    newConceptIds,
    reviewSelectionTrace,
  );

  for (const [conceptId, dueCards] of dueCardsByConcept) {
    const candidate = buildReviewCandidateForConcept(
      state,
      content,
      now,
      conceptId,
      dueCards,
      courseContexts,
      masteryByKey,
      recentIds,
      candidates,
      reviewSelectionTrace,
    );
    if (candidate) candidates.push(candidate);
  }
  const cardsByConcept = new Map<string, SchedulerState['cards']>();
  for (const card of state.cards) {
    const conceptCards = cardsByConcept.get(card.conceptId) ?? [];
    conceptCards.push(card);
    cardsByConcept.set(card.conceptId, conceptCards);
  }
  for (const [conceptId, conceptCards] of cardsByConcept) {
    if (
      dueCardsByConcept.has(conceptId) ||
      state.reviewedTodayConceptIds.includes(conceptId) ||
      (focusSubjectId && !newConceptIds.has(conceptId)) ||
      !conceptCards.some((card) => card.fsrs && card.fsrs.state !== State.New)
    ) {
      continue;
    }
    const candidate = buildReviewCandidateForConcept(
      state,
      content,
      now,
      conceptId,
      conceptCards,
      courseContexts,
      masteryByKey,
      recentIds,
      candidates,
    );
    if (candidate) candidates.push(candidate);
  }
  const remediationByPrereq = new Map<string, string[]>();
  for (const flag of state.remediationFlags ?? []) {
    if (
      flag.status === 'resolved' ||
      !flag.targetPrereqId ||
      !content.conceptsById.has(flag.targetPrereqId)
    ) {
      continue;
    }
    const lessonConceptIds = remediationByPrereq.get(flag.targetPrereqId) ?? [];
    lessonConceptIds.push(flag.conceptId);
    remediationByPrereq.set(flag.targetPrereqId, lessonConceptIds);
  }
  for (const [prereqId, lessonConceptIds] of remediationByPrereq) {
    const prereq = content.conceptsById.get(prereqId);
    if (!prereq || prereq.status === 'stub') continue;
    const activity = buildRemedialReviewActivityForConcept(state, content, now, prereqId);
    if (!activity) continue;
    const retryingConcept = content.conceptsById.get(lessonConceptIds[0] ?? '');
    activity.reason.summary = `Review ${prereq.title} before retrying ${retryingConcept?.title ?? lessonConceptIds[0] ?? 'the lesson'}`;
    activity.reason.terms.review += 1000;
    candidates.splice(
      0,
      candidates.length,
      ...candidates.filter(
        (candidate) =>
          candidate.activity.kind !== 'review' || candidate.activity.conceptId !== prereqId,
      ),
    );
    candidates.push({
      activity,
      score: scoreTerms(activity.reason.terms, activity.plannedMinutes),
      adjustedMinutes: activity.plannedMinutes,
      newConcept: false,
      remediation: true,
      courseId: activity.reason.courseId,
    });
  }
  return candidates;
}

function buildReviewCandidateForConcept(
  state: SchedulerState,
  content: ContentIndex,
  now: Date,
  conceptId: string,
  dueCards: SchedulerState['cards'],
  courseContexts: SchedulerCourseContext[],
  masteryByKey: Map<string, MasteryRecord>,
  recentIds: Set<string>,
  candidates: Candidate[],
  reviewSelectionTrace?: ReviewSelectionTrace,
): Candidate | undefined {
  const concept = content.conceptsById.get(conceptId);
  if (!concept) return undefined;
  const usedExerciseIds = new Set(state.usedExerciseIds ?? []);
  const dueDimensions = new Set(dueCards.map((card) => card.dimension));
  const conceptExercises = content.exercisesByConcept.get(concept.id) ?? [];
  const recallPool = conceptExercises.filter(
    (exercise) =>
      exercise.role === 'recall' &&
      exercise.knowledge_point !== undefined &&
      dueDimensions.has(exercise.dimension) &&
      !usedExerciseIds.has(exercise.id) &&
      !exercise.lesson_only &&
      !isTemplate(exercise),
  );
  const recallAttemptsByExerciseId = new Map<
    string,
    NonNullable<SchedulerState['recallAttempts']>[number]
  >((state.recallAttempts ?? []).map((attempt) => [attempt.exerciseId, attempt]));
  const orderedRecallPoints = (content.lessonsByConcept.get(conceptId)?.knowledge_points ?? [])
    .map((point, pointIndex) => {
      const poolItems = recallPool.filter((exercise) => exercise.knowledge_point === point.id);
      if (poolItems.length === 0) return undefined;
      let last: NonNullable<SchedulerState['recallAttempts']>[number] | undefined;
      for (const exercise of conceptExercises) {
        if (exercise.role !== 'recall' || exercise.knowledge_point !== point.id) continue;
        const attempt = recallAttemptsByExerciseId.get(exercise.id);
        if (attempt && (!last || Date.parse(attempt.createdAt) > Date.parse(last.createdAt))) {
          last = attempt;
        }
      }
      return { pointIndex, poolItems, last };
    })
    .filter((point): point is NonNullable<typeof point> => point !== undefined)
    .sort((left, right) => {
      const group = (point: typeof left) => (!point.last ? 1 : point.last.correct < 1 ? 0 : 2);
      const leftGroup = group(left);
      const rightGroup = group(right);
      const attemptTimeOrder =
        left.last && right.last
          ? Date.parse(left.last.createdAt) - Date.parse(right.last.createdAt)
          : 0;
      return (
        leftGroup - rightGroup ||
        (leftGroup === 1 ? 0 : attemptTimeOrder) ||
        left.pointIndex - right.pointIndex
      );
    });
  const selectedRecallExercises = orderedRecallPoints.slice(0, 2).flatMap(({ poolItems }) => {
    let selected: IndexedExercise | undefined;
    for (const exercise of poolItems) {
      const attempt = recallAttemptsByExerciseId.get(exercise.id);
      const selectedAttempt = selected ? recallAttemptsByExerciseId.get(selected.id) : undefined;
      if (
        !selected ||
        (!attempt && selectedAttempt) ||
        (attempt &&
          selectedAttempt &&
          Date.parse(attempt.createdAt) < Date.parse(selectedAttempt.createdAt))
      ) {
        selected = exercise;
      }
    }
    if (!selected) return [];
    usedExerciseIds.add(selected.id);
    return [selected];
  });
  const problemTarget = selectedRecallExercises.length > 0 ? 2 : 3;
  const perDimension = Math.max(1, Math.ceil(problemTarget / dueCards.length));
  const selectedByDimension: {
    card: SchedulerState['cards'][number];
    exercises: IndexedExercise[];
  }[] = [];
  for (const card of dueCards) {
    const record = masteryByKey.get(masteryKey(card.conceptId, card.dimension));
    const isIndependent = record && masteryRank(record.state) >= masteryRank('independent');
    const reviewRoles = isIndependent
      ? ['transfer', 'review', 'core', 'practice', 'basics']
      : ['review', 'core', 'practice', 'transfer', 'basics'];
    const exercises: IndexedExercise[] = [];
    while (exercises.length < perDimension) {
      const exercise = chooseExercise(
        { ...state, usedExerciseIds: [...usedExerciseIds] },
        content,
        concept,
        card.dimension,
        reviewRoles,
        now,
        recentIds,
      );
      if (!exercise) break;
      usedExerciseIds.add(exercise.id);
      exercises.push(exercise);
    }
    if (exercises.length > 0) selectedByDimension.push({ card, exercises });
  }
  if (selectedByDimension.length === 0 && selectedRecallExercises.length === 0) {
    reviewSelectionTrace?.results.set(conceptId, 'not_candidate:noEligibleExercise');
    return undefined;
  }
  const selectedDimensions = new Set([
    ...selectedByDimension.map(({ card }) => card.dimension),
    ...selectedRecallExercises.map((exercise) => exercise.dimension),
  ]);
  const includedCards = dueCards.filter((card) => selectedDimensions.has(card.dimension));
  const maxQuestions = Math.max(0, ...selectedByDimension.map(({ exercises }) => exercises.length));
  const problemExercises: IndexedExercise[] = [];
  for (let questionIndex = 0; questionIndex < maxQuestions; questionIndex += 1) {
    for (const dimension of selectedByDimension) {
      const exercise = dimension.exercises[questionIndex];
      if (exercise) problemExercises.push(exercise);
    }
  }
  const exercises = [...selectedRecallExercises, ...problemExercises];
  const terms = noTerms();
  terms.review = Math.max(
    ...includedCards.map((card) => {
      const dueAt = Date.parse(card.dueAt);
      const overdueDays = Math.min(10, Math.max(0, (now.getTime() - dueAt) / 86_400_000));
      return (1 - (card.retrievability ?? 0.9)) * 3 + Math.min(2, overdueDays * 0.2);
    }),
  );
  const plannedNewConceptNeedsPrerequisite = candidates.some((candidate) => {
    const plannedConceptId = candidate.activity.conceptId;
    if (candidate.activity.kind !== 'learn' || !plannedConceptId) return false;
    return content.conceptsById
      .get(plannedConceptId)
      ?.prereqs.some(
        (prerequisite) => prerequisite.strength === 'hard' && prerequisite.id === conceptId,
      );
  });
  if (plannedNewConceptNeedsPrerequisite) terms.review += 2;
  const reviewCourseContext =
    courseContexts.find((course) => course.newConceptIds.has(concept.id)) ??
    fallbackCourseContext(state, content);
  if (!reviewCourseContext) {
    reviewSelectionTrace?.results.set(conceptId, 'rejected:other');
    return undefined;
  }
  const reviewProjectId =
    reviewCourseContext.course.units[reviewCourseContext.currentUnit - 1]?.project;
  const reviewProject = reviewProjectId ? content.projectsById.get(reviewProjectId) : undefined;
  const candidate = makeCandidate(
    state,
    content,
    concept,
    'review',
    exercises,
    reviewCourseContext,
    reviewProject,
  );
  candidate.activity.reason.terms.review = terms.review;
  candidate.score = scoreTerms(candidate.activity.reason.terms, candidate.adjustedMinutes);
  const earliestDueAt = Math.min(...includedCards.map((card) => Date.parse(card.dueAt)));
  const lowestRetrievability = Math.min(...includedCards.map((card) => card.retrievability ?? 0.9));
  const dueDate = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: state.timezone ?? 'UTC',
  }).format(new Date(earliestDueAt));
  candidate.activity.reason.summary = `Due since ${dueDate} · ~${Math.round(lowestRetrievability * 100)}% recall.`;
  return candidate;
}

function collectDueReviewCards(
  state: SchedulerState,
  content: ContentIndex,
  now: Date,
  focusSubjectId: string | null | undefined,
  newConceptIds: Set<string>,
  reviewSelectionTrace?: ReviewSelectionTrace,
) {
  const dueCardsByConcept = new Map<string, SchedulerState['cards']>();
  const timezone = state.timezone ?? 'UTC';
  const reviewedToday = new Set(state.reviewedTodayConceptIds);
  for (const card of state.cards) {
    if (!isDueToday(card.dueAt, now, timezone)) continue;
    if (reviewedToday.has(card.conceptId)) {
      reviewSelectionTrace?.results.set(card.conceptId, 'not_candidate:reviewedToday');
      continue;
    }
    const concept = content.conceptsById.get(card.conceptId);
    if (!concept || concept.status === 'stub') {
      reviewSelectionTrace?.results.set(card.conceptId, 'not_candidate:stub');
      continue;
    }
    if (focusSubjectId && !newConceptIds.has(concept.id)) {
      reviewSelectionTrace?.results.set(card.conceptId, 'not_candidate:focusFilter');
      continue;
    }
    const dueCards = dueCardsByConcept.get(card.conceptId) ?? [];
    dueCards.push(card);
    dueCardsByConcept.set(card.conceptId, dueCards);
  }
  return dueCardsByConcept;
}

export function buildReviewActivityForConcept(
  state: SchedulerState,
  content: ContentIndex,
  now: Date,
  conceptId: string,
  dueCardsOverride?: SchedulerState['cards'],
): PlannedActivity | undefined {
  const dueCardState = dueCardsOverride ? { ...state, cards: dueCardsOverride } : state;
  const courseContexts = schedulerCourseContexts(state, content);
  const focusSubjectId = effectiveFocusSubjectId(
    { focusSubjectId: state.focusSubjectId },
    state.studyCourseIds,
    content,
  );
  const newConceptIds = new Set(courseContexts.flatMap((course) => [...course.newConceptIds]));
  const masteryByKey = new Map(
    state.mastery.map((record) => [masteryKey(record.conceptId, record.dimension), record]),
  );
  const recentIds = new Set(
    state.recentAttempts
      .filter((attempt) => daysSince(attempt.createdAt, now) < SCHEDULER_CONFIG.repeatWindowDays)
      .map((attempt) => attempt.exerciseId),
  );
  const dueCards = collectDueReviewCards(
    dueCardState,
    content,
    now,
    focusSubjectId,
    newConceptIds,
  ).get(conceptId);
  if (!dueCards) return undefined;
  return buildReviewCandidateForConcept(
    state,
    content,
    now,
    conceptId,
    dueCards,
    courseContexts,
    masteryByKey,
    recentIds,
    [],
  )?.activity;
}

export function buildRemedialReviewActivityForConcept(
  state: SchedulerState,
  content: ContentIndex,
  now: Date,
  conceptId: string,
): PlannedActivity | undefined {
  const concept = content.conceptsById.get(conceptId);
  if (!concept) return undefined;
  const dueAt = now.toISOString();
  const cards = state.cards.filter((card) => card.conceptId === conceptId);
  const dueCards = cards.length
    ? cards.map((card) => ({ ...card, dueAt }))
    : concept.dimensions.map((dimension) => ({ conceptId, dimension, dueAt, retrievability: 0 }));
  return buildReviewActivityForConcept(
    { ...state, focusSubjectId: undefined },
    content,
    now,
    conceptId,
    dueCards,
  );
}

export function adjustedMinutesForLearnerPace(baseMinutes: number, actualEstimateRatio?: number) {
  const ratio = Math.min(2, Math.max(0.5, actualEstimateRatio ?? 1));
  return Math.max(1, Math.ceil(baseMinutes * ratio));
}

function makeCandidate(
  state: SchedulerState,
  content: ContentIndex,
  concept: IndexedConcept,
  kind: ActivityKind,
  exercises: IndexedExercise[],
  courseContext: SchedulerCourseContext,
  project?: { id: string; prereqs: string[] },
  newConcept = false,
  gap = 0,
  summary?: string,
): Candidate {
  const baseMinutes =
    kind === 'learn'
      ? concept.est_minutes
      : exercises.length > 0
        ? exercises.reduce((sum, exercise) => sum + exercise.est_minutes, 0)
        : concept.est_minutes;
  const adjustedMinutes = adjustedMinutesForLearnerPace(baseMinutes, state.actualEstimateRatio);
  const terms = noTerms();
  terms.goal = concept.goal_weight;
  const unitPosition = courseContext.unitPositions.get(concept.id);
  terms.week_fit =
    unitPosition === undefined
      ? 0
      : unitPosition === courseContext.currentUnit
        ? 3
        : unitPosition === courseContext.currentUnit + 1
          ? 1
          : unitPosition > courseContext.currentUnit + 1
            ? -2 * (unitPosition - courseContext.currentUnit)
            : 0;
  terms.project = project?.prereqs.includes(concept.id) ? 3 : 0;
  terms.unlock = Math.log2(1 + goalWeightedUnlocks(concept.id, content));
  terms.gap = gap;
  terms.cost = -adjustedMinutes / 10;
  const reason: ActivityReason = {
    courseId: courseContext.course.id,
    terms,
    summary: summary ?? candidateSummary(kind, concept, terms, courseContext, project, content),
  };
  const activity: PlannedActivity = {
    kind,
    conceptId: concept.id,
    exerciseIds: exercises.map((exercise) => exercise.id),
    plannedMinutes: adjustedMinutes,
    reason,
  };
  return {
    activity,
    adjustedMinutes,
    newConcept,
    courseId: courseContext.course.id,
    score: scoreTerms(terms, adjustedMinutes),
  };
}

function candidateSummary(
  kind: ActivityKind,
  concept: IndexedConcept,
  terms: PriorityTerms,
  courseContext: SchedulerCourseContext,
  project: { id: string; prereqs: string[] } | undefined,
  content: ContentIndex,
): string {
  const parts: string[] = [];
  if (
    terms.week_fit > 0 &&
    courseContext.unitPositions.get(concept.id) === courseContext.currentUnit
  ) {
    parts.push(`${courseContext.unitTitle} focus`);
  }
  if (terms.unlock > 0) {
    const unlocked = goalWeightedUnlockTitles(concept.id, content);
    if (unlocked.length) parts.push(`unlocks ${unlocked.join(', ')}`);
  }
  if (terms.project > 0 && project) {
    const projectTitle = content.projectsById.get(project.id)?.title ?? project.id;
    parts.push(`needed for the optional project (${projectTitle})`);
  }
  if (terms.goal > 0 && parts.length === 0) parts.push('supports your learning goal');
  if (terms.gap > 0) parts.push('addresses a learning gap');
  return parts.length
    ? parts.join(' · ')
    : `${kind === 'learn' ? 'Learn' : 'Practice'} ${concept.title}.`;
}

function chooseExercise(
  state: SchedulerState,
  content: ContentIndex,
  concept: IndexedConcept,
  dimension: string | undefined,
  preferredRoles: string[],
  now: Date,
  recentIds?: Set<string>,
): IndexedExercise | undefined {
  const used = new Set(state.usedExerciseIds ?? []);
  const recent =
    recentIds ??
    new Set(
      state.recentAttempts
        .filter((attempt) => daysSince(attempt.createdAt, now) < SCHEDULER_CONFIG.repeatWindowDays)
        .map((attempt) => attempt.exerciseId),
    );
  const pool = (content.exercisesByConcept.get(concept.id) ?? []).filter(
    (exercise) =>
      (!dimension || exercise.dimension === dimension) &&
      !used.has(exercise.id) &&
      !isTemplate(exercise) &&
      !exercise.lesson_only,
  );
  const leastRecentlySeen = (exercises: IndexedExercise[]) =>
    exercises.sort((left, right) => lastSeen(left.id, state) - lastSeen(right.id, state))[0];
  for (const role of preferredRoles) {
    const fresh = pool.filter((exercise) => exercise.role === role && !recent.has(exercise.id));
    if (fresh.length > 0) return leastRecentlySeen(fresh);
  }
  for (const role of preferredRoles) {
    const matching = pool.filter((exercise) => exercise.role === role);
    if (matching.length > 0) return leastRecentlySeen(matching);
  }
  return undefined;
}

function optionalProjectAndPaperActivities(
  state: SchedulerState,
  content: ContentIndex,
  budget: number,
  activityCount: number,
  courseId?: string,
): PlannedActivity[] {
  if (
    budget <= 0 ||
    activityCount >= SCHEDULER_CONFIG.weekday.maxActivities ||
    state.studyCourseIds.length === 0
  )
    return [];
  const courseContext = fallbackCourseContext(state, content, courseId);
  if (!courseContext) return [];
  const currentUnit = courseContext.course.units[courseContext.currentUnit - 1];
  const hasUnreadPaper = (currentUnit?.papers ?? []).some(
    (paperId) => !state.completedPaperIds.includes(paperId),
  );
  const paperMinutes = hasUnreadPaper ? Math.min(90, budget) : 0;
  const activities: PlannedActivity[] = [];
  let remainingMinutes = budget;
  if (paperMinutes >= 30) {
    activities.push({
      kind: 'paper',
      exerciseIds: [],
      plannedMinutes: paperMinutes,
      reason: staticReason(`Optional paper for ${courseContext.unitTitle}.`),
    });
    remainingMinutes -= paperMinutes;
  }
  const masteryByKey = new Map(
    state.mastery.map((record) => [masteryKey(record.conceptId, record.dimension), record]),
  );
  const lessonRuns = state.lessonRuns ?? [];
  const availableProjects = content.projects.filter((project) =>
    projectReady(project, masteryByKey, lessonRuns, content),
  );
  const courseProjectIds = courseContext.course.units
    .slice(0, courseContext.currentUnit)
    .flatMap((unit) => (unit.project ? [unit.project] : []));
  const activeProjectIds = new Set(courseProjectIds);
  const preferredProjectId =
    state.currentProjectId && activeProjectIds.has(state.currentProjectId)
      ? state.currentProjectId
      : currentUnit?.project;
  const currentProject =
    availableProjects.find((project) => project.id === preferredProjectId)?.id ??
    [...courseProjectIds]
      .reverse()
      .find(
        (projectId) =>
          availableProjects.some((project) => project.id === projectId) &&
          !state.projectProgress.some(
            (item) => item.projectId === projectId && item.status === 'completed',
          ),
      );
  const projectDone =
    currentProject &&
    state.projectProgress.some(
      (item) => item.projectId === currentProject && item.status === 'completed',
    );
  if (
    currentProject &&
    !projectDone &&
    remainingMinutes > 0 &&
    activityCount + activities.length < SCHEDULER_CONFIG.weekday.maxActivities
  ) {
    activities.push({
      kind: 'lab',
      projectId: currentProject,
      exerciseIds: [],
      plannedMinutes: remainingMinutes,
      reason: staticReason(`Lab activity references project ${currentProject}.`),
    });
  }
  return activities;
}

function staticReason(summary: string): ActivityReason {
  return { terms: noTerms(), summary };
}

function usesSelectedExercise(candidate: Candidate, selected: Candidate[]): boolean {
  const used = new Set(selected.flatMap((entry) => entry.activity.exerciseIds));
  return candidate.activity.exerciseIds.some((exerciseId) => used.has(exerciseId));
}

function scoreTerms(terms: PriorityTerms, minutes: number): number {
  const weighted = Object.entries(terms).reduce(
    (total, [key, value]) => total + value * SCHEDULER_CONFIG.weights[key as keyof PriorityTerms],
    0,
  );
  return weighted / Math.sqrt(Math.max(1, minutes));
}

function goalWeightedUnlockTitles(conceptId: string, content: ContentIndex): string[] {
  const unlocked = new Set<string>();
  const frontier = [conceptId];
  while (frontier.length > 0) {
    const current = frontier.shift();
    if (!current) continue;
    for (const concept of content.concepts) {
      if (
        concept.prereqs.some(
          (prerequisite) => prerequisite.strength === 'hard' && prerequisite.id === current,
        ) &&
        !unlocked.has(concept.id)
      ) {
        unlocked.add(concept.id);
        frontier.push(concept.id);
      }
    }
  }
  return [...unlocked]
    .map((id) => content.conceptsById.get(id))
    .filter((concept): concept is IndexedConcept => Boolean(concept?.goal_weight))
    .sort((left, right) => right.goal_weight - left.goal_weight)
    .slice(0, 2)
    .map((concept) => concept.title);
}

function goalWeightedUnlocks(conceptId: string, content: ContentIndex): number {
  const unlocked = new Set<string>();
  const frontier = [conceptId];
  while (frontier.length > 0) {
    const current = frontier.shift();
    if (!current) {
      continue;
    }
    for (const concept of content.concepts) {
      if (
        concept.prereqs.some(
          (prerequisite) => prerequisite.strength === 'hard' && prerequisite.id === current,
        )
      ) {
        if (!unlocked.has(concept.id)) {
          unlocked.add(concept.id);
          frontier.push(concept.id);
        }
      }
    }
  }
  return [...unlocked].filter((id) => (content.conceptsById.get(id)?.goal_weight ?? 0) > 0).length;
}

function lastSeen(exerciseId: string, state: SchedulerState): number {
  const attempt = state.recentAttempts.find((entry) => entry.exerciseId === exerciseId);
  return attempt ? Date.parse(attempt.createdAt) : 0;
}

function daysSince(iso: string, now: Date): number {
  return (now.getTime() - Date.parse(iso)) / 86_400_000;
}
