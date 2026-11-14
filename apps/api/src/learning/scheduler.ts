import { isTemplate } from '../content/templates.js';
import type {
  ContentIndex,
  IndexedConcept,
  IndexedCourse,
  IndexedExercise,
} from '../content/types.js';
import {
  activeCourseFor,
  compareOutlinePosition,
  courseConceptIds,
  courseFoundationIds,
  courseUnitPositions,
  masteryKey,
  prerequisiteMet,
} from './prerequisites.js';
import type { SessionKind } from './session-budget.js';
import type { MasteryRecord } from './types.js';
import { masteryRank } from './types.js';
import { localDateKey } from './xp.js';

export type { SessionKind, SessionPreferences } from './session-budget.js';
export { sessionBudget } from './session-budget.js';

export type ActivityKind =
  | 'review'
  | 'learn'
  | 'practice'
  | 'remediate'
  | 'quick_check'
  | 'transfer'
  | 'lab'
  | 'reflect'
  | 'teachback'
  | 'paper';

export const SCHEDULER_CONFIG = {
  weights: { goal: 1, week_fit: 1, project: 1, unlock: 1, gap: 1, review: 1, cost: 1 },
  weekday: {
    reviewBudgetRatio: 0.3,
    maxNewConcepts: 2,
    maxActivities: 6,
  },
  repeatWindowDays: 7,
  consolidationMinutes: 5,
} as const;

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
  terms: PriorityTerms;
  summary: string;
}

export interface PlannedActivity {
  kind: ActivityKind;
  conceptId?: string;
  projectId?: string;
  exerciseIds: string[];
  plannedMinutes: number;
  reason: ActivityReason;
  status?: 'planned' | 'in_progress' | 'completed';
}

export interface SchedulerState {
  timezone?: string;
  activeCourseId: string | null;
  studyCourseIds: string[];
  recentLearnMinutesByConcept: Record<string, number>;
  mastery: MasteryRecord[];
  cards: Array<{
    conceptId: string;
    dimension: MasteryRecord['dimension'];
    dueAt: string;
    retrievability?: number;
  }>;
  recentAttempts: Array<{
    conceptId: string;
    exerciseId: string;
    dimension?: MasteryRecord['dimension'];
    correct: number;
    itemRole: string;
    createdAt: string;
  }>;
  remediationFlags: Array<{
    conceptId: string;
    targetPrereqId?: string;
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
  }>;
}

export interface SessionPlan {
  activities: PlannedActivity[];
  reasons: ActivityReason[];
}

interface Candidate {
  activity: PlannedActivity;
  score: number;
  adjustedMinutes: number;
  newConcept: boolean;
  courseId?: string;
}

interface SchedulerCourseContext {
  course: IndexedCourse;
  currentUnit: number;
  unitTitle: string;
  unitPositions: Map<string, number>;
  newConceptIds: Set<string>;
}

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

function isLearnableConcept(concept: IndexedConcept, content: ContentIndex): boolean {
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
  state: SchedulerState,
  content: ContentIndex,
): SchedulerCourseContext[] {
  return state.studyCourseIds.flatMap((courseId) => {
    const context = schedulerCourseContextFor(state, content, courseId);
    return context ? [context] : [];
  });
}

function schedulerCourseContextFor(
  state: SchedulerState,
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
  state: SchedulerState,
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
): SessionPlan {
  return packWeekday(state, content, now, Math.max(0, budgetMinutes));
}

export function replan(
  state: SchedulerState,
  content: ContentIndex,
  now: Date,
  remainingBudgetMinutes: number,
  existingActivities: PlannedActivity[],
  kind: SessionKind = 'weekday',
): SessionPlan {
  const inProgress = existingActivities.filter(
    (activity) =>
      activity.status === 'in_progress' &&
      (!activity.conceptId || content.conceptsById.get(activity.conceptId)?.status !== 'stub'),
  );
  const completed = existingActivities.filter((activity) => activity.status === 'completed');
  const protectedExerciseIds = [
    ...(state.usedExerciseIds ?? []),
    ...inProgress.flatMap((activity) => activity.exerciseIds),
    ...completed.flatMap((activity) => activity.exerciseIds),
  ];
  const nextState = { ...state, usedExerciseIds: protectedExerciseIds };
  const plan = planSession(nextState, content, now, remainingBudgetMinutes, kind);
  return {
    activities: [...inProgress, ...plan.activities],
    reasons: [...inProgress.map((activity) => activity.reason), ...plan.reasons],
  };
}

function packWeekday(
  state: SchedulerState,
  content: ContentIndex,
  now: Date,
  budget: number,
): SessionPlan {
  const candidates = generateCandidates(state, content, now);
  const selected: Candidate[] = [];
  let usedMinutes = 0;
  let newConceptCount = 0;
  const selectedConcepts = new Set<string>();
  const canAdd = (candidate: Candidate) => {
    const reviewAlongsideLesson =
      candidate.activity.kind === 'review' &&
      Boolean(candidate.activity.conceptId) &&
      selected.some(
        (selectedCandidate) =>
          selectedCandidate.activity.kind === 'learn' &&
          selectedCandidate.activity.conceptId === candidate.activity.conceptId,
      );
    return (
      selected.length < SCHEDULER_CONFIG.weekday.maxActivities &&
      usedMinutes + candidate.adjustedMinutes <= budget &&
      !usesSelectedExercise(candidate, selected) &&
      (!candidate.activity.conceptId ||
        !selectedConcepts.has(candidate.activity.conceptId) ||
        reviewAlongsideLesson)
    );
  };
  const add = (candidate: Candidate) => {
    if (!canAdd(candidate)) return false;
    selected.push(candidate);
    usedMinutes += candidate.adjustedMinutes;
    if (candidate.activity.conceptId) selectedConcepts.add(candidate.activity.conceptId);
    return true;
  };
  const unfinishedLessonConcepts = new Set(
    (state.lessonRuns ?? [])
      .filter(
        (run) =>
          run.status === 'in_progress' || run.status === 'needs_retry' || run.status === 'quiz',
      )
      .map((run) => run.conceptId),
  );
  const courseContexts = schedulerCourseContexts(state, content);
  const courseOrder = new Map(courseContexts.map((course, index) => [course.course.id, index]));
  const compareLearnCandidates = (left: Candidate, right: Candidate) => {
    const leftInProgress = left.activity.conceptId === state.inProgressConceptId;
    const rightInProgress = right.activity.conceptId === state.inProgressConceptId;
    if (leftInProgress !== rightInProgress) return leftInProgress ? -1 : 1;
    const outlineOrder = compareOutlinePosition(
      left.activity.conceptId ?? '',
      right.activity.conceptId ?? '',
      content,
      left.courseId ?? state.activeCourseId,
    );
    return (
      (courseOrder.get(left.courseId ?? '') ?? Infinity) -
        (courseOrder.get(right.courseId ?? '') ?? Infinity) ||
      outlineOrder ||
      right.score - left.score
    );
  };
  for (const candidate of candidates
    .filter(
      (entry) =>
        entry.activity.kind === 'learn' &&
        entry.activity.conceptId &&
        unfinishedLessonConcepts.has(entry.activity.conceptId),
    )
    .sort(compareLearnCandidates)) {
    if (newConceptCount >= SCHEDULER_CONFIG.weekday.maxNewConcepts) break;
    if (add(candidate)) newConceptCount += 1;
  }
  const reviewCandidates = candidates
    .filter((candidate) => candidate.activity.kind === 'review')
    .sort((left, right) => right.score - left.score);
  const reviewCap = Math.floor(budget * SCHEDULER_CONFIG.weekday.reviewBudgetRatio);
  let reviewMinutes = 0;
  for (const candidate of reviewCandidates) {
    if (reviewMinutes + candidate.adjustedMinutes > reviewCap) continue;
    if (add(candidate)) reviewMinutes += candidate.adjustedMinutes;
  }
  if (!selected.some((candidate) => candidate.activity.kind === 'review')) {
    const fallbackReview = reviewCandidates.find(canAdd);
    if (fallbackReview) add(fallbackReview);
  }
  const learnCandidates = candidates
    .filter((candidate) => candidate.activity.kind === 'learn')
    .filter((candidate) => !unfinishedLessonConcepts.has(candidate.activity.conceptId ?? ''));
  const candidatesByCourse = new Map<string, Candidate[]>();
  for (const candidate of learnCandidates) {
    if (!candidate.courseId) continue;
    const group = candidatesByCourse.get(candidate.courseId) ?? [];
    group.push(candidate);
    candidatesByCourse.set(candidate.courseId, group);
  }
  for (const group of candidatesByCourse.values()) group.sort(compareLearnCandidates);
  const selectedLearnMinutesByCourse = new Map<string, number>();
  while (newConceptCount < SCHEDULER_CONFIG.weekday.maxNewConcepts) {
    const nextCourse = courseContexts
      .filter((course) => candidatesByCourse.get(course.course.id)?.some(canAdd))
      .sort((left, right) => {
        const minutes = (course: SchedulerCourseContext) => {
          const recentMinutes = Object.entries(state.recentLearnMinutesByConcept)
            .filter(
              ([conceptId]) =>
                course.newConceptIds.has(conceptId) &&
                courseContexts.find((candidate) => candidate.newConceptIds.has(conceptId))?.course
                  .id === course.course.id,
            )
            .reduce((sum, [, value]) => sum + value, 0);
          return recentMinutes + (selectedLearnMinutesByCourse.get(course.course.id) ?? 0);
        };
        return minutes(left) - minutes(right);
      })[0];
    if (!nextCourse) break;
    const nextCandidates = candidatesByCourse.get(nextCourse.course.id) ?? [];
    const candidate = nextCandidates.find(canAdd);
    if (!candidate || !add(candidate)) {
      nextCandidates.length = 0;
      continue;
    }
    newConceptCount += 1;
    selectedLearnMinutesByCourse.set(
      nextCourse.course.id,
      (selectedLearnMinutesByCourse.get(nextCourse.course.id) ?? 0) +
        candidate.activity.plannedMinutes,
    );
    nextCandidates.splice(nextCandidates.indexOf(candidate), 1);
  }

  const otherCandidates = candidates
    .filter((candidate) => !['review', 'learn'].includes(candidate.activity.kind))
    .sort((left, right) => right.score - left.score);
  for (const candidate of otherCandidates) add(candidate);

  const optionalActivities = optionalProjectAndPaperActivities(
    state,
    content,
    Math.max(0, budget - usedMinutes),
    selected.length,
    selected.find((candidate) => candidate.activity.kind === 'learn')?.courseId,
  );
  const activities = [...selected.map((candidate) => candidate.activity), ...optionalActivities];
  return { activities, reasons: activities.map((activity) => activity.reason) };
}

function generateCandidates(state: SchedulerState, content: ContentIndex, now: Date): Candidate[] {
  const candidates: Candidate[] = [];
  const courseContexts = schedulerCourseContexts(state, content);
  const newConceptIds = new Set(courseContexts.flatMap((course) => [...course.newConceptIds]));
  const masteryByKey = new Map(
    state.mastery.map((record) => [masteryKey(record.conceptId, record.dimension), record]),
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
    const prereqsReady = concept.prereqs
      .filter((prerequisite) => prerequisite.strength === 'hard')
      .every((prerequisite) =>
        prerequisiteMet(prerequisite.id, masteryByKey, state.lessonRuns ?? [], content),
      );
    const allNotAssessed = states.every((record) => !record || record.state === 'not_assessed');
    const isNew =
      newConceptIds.has(concept.id) &&
      prereqsReady &&
      (allNotAssessed || states.some((record) => record?.state === 'introduced'));
    const isContinuing =
      newConceptIds.has(concept.id) &&
      states.some((record) => record?.state === 'introduced' || record?.state === 'assisted');
    const hasKnowledgePointLesson = hasKnowledgePointLessonContent(concept.id, content);
    const lessonRunStatus = state.lessonRuns?.find((run) => run.conceptId === concept.id)?.status;
    const shouldResumeLesson =
      newConceptIds.has(concept.id) &&
      hasKnowledgePointLesson &&
      prereqsReady &&
      (lessonRunStatus === 'in_progress' ||
        lessonRunStatus === 'needs_retry' ||
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

  for (const card of state.cards) {
    if (Date.parse(card.dueAt) > now.getTime()) {
      continue;
    }
    const timezone = state.timezone ?? 'UTC';
    const localToday = localDateKey(now, timezone);
    const attemptedToday = state.recentAttempts.some(
      (attempt) =>
        attempt.conceptId === card.conceptId &&
        attempt.dimension === card.dimension &&
        localDateKey(new Date(attempt.createdAt), timezone) === localToday,
    );
    if (attemptedToday) {
      continue;
    }
    const concept = content.conceptsById.get(card.conceptId);
    if (!concept || concept.status === 'stub') {
      continue;
    }
    const record = masteryByKey.get(masteryKey(card.conceptId, card.dimension));
    const isIndependent = record && masteryRank(record.state) >= masteryRank('independent');
    const reviewRoles = isIndependent
      ? ['transfer', 'review', 'core', 'practice', 'basics']
      : ['review', 'core', 'practice', 'transfer', 'basics'];
    const usedExerciseIds = new Set(state.usedExerciseIds ?? []);
    const exercises: IndexedExercise[] = [];
    while (exercises.length < 3) {
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
    if (exercises.length === 0) {
      continue;
    }
    const dueAt = Date.parse(card.dueAt);
    const overdueDays = Math.min(10, Math.max(0, (now.getTime() - dueAt) / 86_400_000));
    const recentFailure = state.recentAttempts.some(
      (attempt) => attempt.conceptId === card.conceptId && attempt.correct === 0,
    );
    const terms = noTerms();
    terms.review =
      (1 - (card.retrievability ?? 0.9)) * 3 +
      (recentFailure ? 2 : 0) +
      Math.min(2, overdueDays * 0.2);
    const plannedNewConceptNeedsPrerequisite = candidates.some((candidate) => {
      const plannedConceptId = candidate.activity.conceptId;
      if (candidate.activity.kind !== 'learn' || !plannedConceptId) return false;
      return content.conceptsById
        .get(plannedConceptId)
        ?.prereqs.some(
          (prerequisite) => prerequisite.strength === 'hard' && prerequisite.id === card.conceptId,
        );
    });
    if (plannedNewConceptNeedsPrerequisite) {
      terms.review += 2;
    }
    const reviewCourseContext =
      courseContexts.find((course) => course.newConceptIds.has(concept.id)) ??
      fallbackCourseContext(state, content);
    if (!reviewCourseContext) continue;
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
    const dueDate = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: state.timezone ?? 'UTC',
    }).format(new Date(card.dueAt));
    candidate.activity.reason.summary = `Due since ${dueDate} · ~${Math.round((card.retrievability ?? 0.9) * 100)}% recall.`;
    candidates.push(candidate);
  }
  return candidates;
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
  const ratio = Math.min(2, Math.max(0.5, state.actualEstimateRatio ?? 1));
  const baseMinutes =
    kind === 'learn'
      ? concept.est_minutes
      : exercises.length > 0
        ? exercises.reduce((sum, exercise) => sum + exercise.est_minutes, 0)
        : concept.est_minutes;
  const adjustedMinutes = Math.max(1, Math.ceil(baseMinutes * ratio));
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
  const availableProjects = content.projects.filter(
    (project) => project.status === 'authored' && project.tests.length > 0,
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
