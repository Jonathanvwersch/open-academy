import { isTemplate } from '../content/templates.js';
import type { ContentIndex, IndexedConcept, IndexedExercise } from '../content/types.js';
import { compareOutlinePosition, masteryKey, prerequisiteMet } from './prerequisites.js';
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
  | 'diagnostic'
  | 'paper';

export const SCHEDULER_CONFIG = {
  weights: { goal: 1, week_fit: 1, project: 1, unlock: 1, gap: 1, review: 1, cost: 1 },
  weekday: {
    reviewBudgetRatio: 0.25,
    maxNewConcepts: 2,
    maxActivities: 6,
  },
  repeatWindowDays: 7,
  consolidationMinutes: 5,
  saturdayReviewMinutes: 10,
  saturdayReflectionMinutes: 10,
  sundayCheckMinutes: 20,
  sundayTeachbackMinutes: 10,
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

export function currentLearnerWeek(
  state: Pick<SchedulerState, 'mastery' | 'lessonRuns'>,
  content: ContentIndex,
): number {
  const weeks = content.curriculum?.weeks;
  if (!weeks?.length) return 1;
  const masteryByKey = new Map(
    state.mastery.map((record) => [masteryKey(record.conceptId, record.dimension), record]),
  );
  const lessonRuns = state.lessonRuns ?? [];
  for (const week of weeks) {
    for (const conceptId of week.concepts) {
      const concept = content.conceptsById.get(conceptId);
      if (
        concept &&
        isLearnableConcept(concept, content) &&
        !prerequisiteMet(conceptId, masteryByKey, lessonRuns, content)
      ) {
        return week.week;
      }
    }
  }
  for (const week of weeks) {
    for (const conceptId of week.concepts) {
      if (!prerequisiteMet(conceptId, masteryByKey, lessonRuns, content)) return week.week;
    }
  }
  return weeks.at(-1)?.week ?? 1;
}

export function planSession(
  state: SchedulerState,
  content: ContentIndex,
  now: Date,
  budgetMinutes: number,
  kind: SessionKind = 'weekday',
): SessionPlan {
  const budget = Math.max(0, budgetMinutes);
  if (kind === 'saturday') {
    return planSaturday(state, content, now, budget);
  }
  if (kind === 'sunday') {
    return planSunday(state, content, now, budget);
  }
  return packWeekday(state, content, now, budget);
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
  const canAdd = (candidate: Candidate, limit = budget) => {
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
      usedMinutes + candidate.adjustedMinutes <= limit &&
      !usesSelectedExercise(candidate, selected) &&
      (!candidate.activity.conceptId ||
        !selectedConcepts.has(candidate.activity.conceptId) ||
        reviewAlongsideLesson)
    );
  };
  const add = (candidate: Candidate, limit = budget) => {
    if (!canAdd(candidate, limit)) return false;
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
  const compareLearnCandidates = (left: Candidate, right: Candidate) => {
    const leftInProgress = left.activity.conceptId === state.inProgressConceptId;
    const rightInProgress = right.activity.conceptId === state.inProgressConceptId;
    if (leftInProgress !== rightInProgress) return leftInProgress ? -1 : 1;
    const outlineOrder = compareOutlinePosition(
      left.activity.conceptId ?? '',
      right.activity.conceptId ?? '',
      content,
    );
    return outlineOrder || right.score - left.score;
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
  const reviewLimit =
    reviewCandidates.length > 0 ? Math.max(reviewCap, Math.min(budget, 1)) : reviewCap;
  for (const candidate of reviewCandidates) {
    add(candidate, reviewLimit);
  }
  if (
    reviewCandidates.length > 0 &&
    !selected.some((candidate) => candidate.activity.kind === 'review')
  ) {
    const first = reviewCandidates.find((candidate) => canAdd(candidate));
    if (first) add(first);
  }
  const learnCandidates = candidates
    .filter((candidate) => candidate.activity.kind === 'learn')
    .sort(compareLearnCandidates);
  for (const candidate of learnCandidates) {
    if (newConceptCount >= SCHEDULER_CONFIG.weekday.maxNewConcepts) break;
    if (add(candidate)) newConceptCount += 1;
  }

  const learnTargets = new Set(
    selected
      .filter((candidate) => candidate.activity.kind === 'learn')
      .map((candidate) => candidate.activity.conceptId)
      .filter((id): id is string => Boolean(id)),
  );
  const prerequisiteIds = new Set(
    [...learnTargets].flatMap(
      (id) =>
        content.conceptsById
          .get(id)
          ?.prereqs.filter((prerequisite) => prerequisite.strength === 'hard')
          .map((prerequisite) => prerequisite.id) ?? [],
    ),
  );
  for (const candidate of candidates
    .filter(
      (entry) =>
        entry.activity.kind === 'quick_check' &&
        Boolean(entry.activity.conceptId && prerequisiteIds.has(entry.activity.conceptId)),
    )
    .sort((left, right) => right.score - left.score)) {
    const dependent = [...learnTargets]
      .map((id) => content.conceptsById.get(id))
      .find((concept) =>
        concept?.prereqs.some((prerequisite) => prerequisite.id === candidate.activity.conceptId),
      );
    if (dependent) {
      candidate.activity.reason.summary = `Confirm diagnostic result before ${dependent.title}.`;
    }
    if (selected.length < SCHEDULER_CONFIG.weekday.maxActivities - 1) add(candidate);
  }

  const otherCandidates = candidates
    .filter((candidate) => !['review', 'learn', 'quick_check'].includes(candidate.activity.kind))
    .sort((left, right) => right.score - left.score);
  for (const candidate of otherCandidates) add(candidate);

  return toPlan(selected);
}

function generateCandidates(state: SchedulerState, content: ContentIndex, now: Date): Candidate[] {
  const candidates: Candidate[] = [];
  const week = currentLearnerWeek(state, content);
  const weekProjectId = content.curriculum?.weeks.find((entry) => entry.week === week)?.project;
  const project = weekProjectId ? content.projectsById.get(weekProjectId) : undefined;
  const masteryByKey = new Map(
    state.mastery.map((record) => [masteryKey(record.conceptId, record.dimension), record]),
  );
  const recentIds = new Set(
    state.recentAttempts
      .filter((attempt) => daysSince(attempt.createdAt, now) < SCHEDULER_CONFIG.repeatWindowDays)
      .map((attempt) => attempt.exerciseId),
  );
  for (const concept of content.concepts) {
    if (concept.status === 'stub') {
      continue;
    }
    const conceptRecords = concept.dimensions
      .map((dimension) => masteryByKey.get(masteryKey(concept.id, dimension)))
      .filter((record): record is MasteryRecord => Boolean(record));
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
      prereqsReady && (allNotAssessed || states.some((record) => record?.state === 'introduced'));
    const isContinuing = states.some(
      (record) => record?.state === 'introduced' || record?.state === 'assisted',
    );
    const hasKnowledgePointLesson = hasKnowledgePointLessonContent(concept.id, content);
    const lessonRunStatus = state.lessonRuns?.find((run) => run.conceptId === concept.id)?.status;
    const shouldResumeLesson =
      hasKnowledgePointLesson &&
      prereqsReady &&
      (lessonRunStatus === 'in_progress' ||
        lessonRunStatus === 'needs_retry' ||
        lessonRunStatus === 'quiz');
    const completedKnowledgePointLesson =
      hasKnowledgePointLesson && lessonRunStatus === 'completed';
    if (shouldResumeLesson) {
      const finalId = content.lessonsByConcept.get(concept.id)?.final;
      const exercise = finalId ? content.exercisesById.get(finalId) : undefined;
      if (exercise) {
        candidates.push(
          makeCandidate(state, content, concept, 'learn', [exercise], week, project, true, 100),
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
            week,
            project,
            isNew,
            isNew ? 0 : 1,
          ),
        );
      }
    }

    if (conceptRecords.some((record) => record.provisional && record.state === 'independent')) {
      const dimension = concept.dimensions.find((candidate) => {
        const record = masteryByKey.get(masteryKey(concept.id, candidate));
        return record?.inferred || record?.provisional;
      });
      const exercise = chooseExercise(
        state,
        content,
        concept,
        dimension,
        ['check', 'core'],
        now,
        recentIds,
      );
      if (exercise) {
        candidates.push(
          makeCandidate(
            state,
            content,
            concept,
            'quick_check',
            [exercise],
            week,
            project,
            false,
            2,
          ),
        );
      }
    }

    const primaryDimensions = concept.dimensions.filter((dimension) => dimension !== 'transfer');
    const independentlyKnown =
      primaryDimensions.length > 0 &&
      primaryDimensions.every((dimension) => {
        const record = masteryByKey.get(masteryKey(concept.id, dimension));
        return (
          record && !record.provisional && masteryRank(record.state) >= masteryRank('independent')
        );
      });
    const hasTransfer = state.recentAttempts.some(
      (attempt) => attempt.conceptId === concept.id && attempt.itemRole === 'transfer',
    );
    if (independentlyKnown && !hasTransfer) {
      const exercise = chooseExercise(
        state,
        content,
        concept,
        'transfer',
        ['transfer'],
        now,
        recentIds,
      );
      if (exercise) {
        candidates.push(
          makeCandidate(state, content, concept, 'transfer', [exercise], week, project, false, 3),
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
    const candidate = makeCandidate(state, content, concept, 'review', exercises, week, project);
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
  week: number,
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
  terms.week_fit =
    concept.week === week
      ? 3
      : concept.week === week + 1
        ? 1
        : concept.week > week + 1
          ? -2 * (concept.week - week)
          : 0;
  terms.project = project?.prereqs.includes(concept.id) ? 3 : 0;
  terms.unlock = Math.log2(1 + goalWeightedUnlocks(concept.id, content));
  terms.gap = gap;
  terms.cost = -adjustedMinutes / 10;
  const reason: ActivityReason = {
    terms,
    summary: summary ?? candidateSummary(kind, concept, terms, week, project, content),
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
    score: scoreTerms(terms, adjustedMinutes),
  };
}

function candidateSummary(
  kind: ActivityKind,
  concept: IndexedConcept,
  terms: PriorityTerms,
  week: number,
  project: { id: string; prereqs: string[] } | undefined,
  content: ContentIndex,
): string {
  if (kind === 'quick_check') return `Confirm the diagnostic result for ${concept.title}.`;
  const parts: string[] = [];
  if (terms.week_fit > 0 && concept.week === week) parts.push(`Week ${week} focus`);
  if (terms.unlock > 0) {
    const unlocked = goalWeightedUnlockTitles(concept.id, content);
    if (unlocked.length) parts.push(`unlocks ${unlocked.join(', ')}`);
  }
  if (terms.project > 0 && project) {
    const projectTitle = content.projectsById.get(project.id)?.title ?? project.id;
    parts.push(`needed for the Saturday lab (${projectTitle})`);
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

function planSaturday(
  state: SchedulerState,
  content: ContentIndex,
  now: Date,
  budget: number,
): SessionPlan {
  const plan: PlannedActivity[] = [];
  const dueReview = generateCandidates(state, content, now).find(
    (candidate) => candidate.activity.kind === 'review',
  );
  const usedExerciseIds = new Set([
    ...(state.usedExerciseIds ?? []),
    ...(dueReview?.activity.exerciseIds ?? []),
  ]);
  if (dueReview && budget > 0) {
    plan.push({ ...dueReview.activity, plannedMinutes: Math.min(10, budget) });
  }
  const warmupMinutes = dueReview ? Math.min(10, budget) : 0;
  const reflectionMinutes = budget >= 20 ? 10 : 0;
  const week = currentLearnerWeek(state, content);
  const remainingMinutes = Math.max(0, budget - warmupMinutes - reflectionMinutes);
  const hasUnreadPaper = (content.papersByWeek.get(week) ?? []).some(
    (paper) => !state.completedPaperIds.includes(paper.id),
  );
  const paperMinutes = hasUnreadPaper ? Math.min(90, remainingMinutes) : 0;
  if (paperMinutes >= 30) {
    plan.push({
      kind: 'paper',
      exerciseIds: [],
      plannedMinutes: paperMinutes,
      reason: staticReason(`Saturday paper reading for week ${week}.`),
    });
  }
  const projectMinutes = Math.max(0, remainingMinutes - (paperMinutes >= 30 ? paperMinutes : 0));
  const availableProjects = content.projects.filter(
    (project) => project.status === 'authored' && project.tests.length > 0,
  );
  const preferredProjectId =
    state.currentProjectId ??
    content.curriculum?.weeks.find((entry) => entry.week === week)?.project ??
    undefined;
  const currentProject =
    availableProjects.find((project) => project.id === preferredProjectId)?.id ??
    availableProjects
      .filter(
        (project) =>
          project.week <= week &&
          !state.projectProgress.some(
            (item) => item.projectId === project.id && item.status === 'completed',
          ),
      )
      .sort((left, right) => right.week - left.week || left.id.localeCompare(right.id))[0]?.id;
  const projectDone =
    currentProject &&
    state.projectProgress.some(
      (item) => item.projectId === currentProject && item.status === 'completed',
    );
  if (currentProject && !projectDone && projectMinutes > 0) {
    plan.push({
      kind: 'lab',
      projectId: currentProject,
      exerciseIds: [],
      plannedMinutes: projectMinutes,
      reason: staticReason(`Lab activity references project ${currentProject}.`),
    });
  }
  if (projectDone && projectMinutes > 0) {
    const extensionConceptId = content.projectsById.get(currentProject)?.prereqs[0];
    const extensionConcept = extensionConceptId
      ? content.conceptsById.get(extensionConceptId)
      : undefined;
    const extension = extensionConcept
      ? chooseExercise(
          state,
          content,
          extensionConcept,
          'implementation',
          ['core', 'transfer'],
          now,
        )
      : undefined;
    if (extension) {
      plan.push(
        staticCandidate(
          'practice',
          extension.concept,
          [extension.id],
          projectMinutes,
          'Extend the completed lab with a fresh implementation item.',
        ),
      );
    }
  }
  if (reflectionMinutes > 0) {
    const reflection = content.projectsById
      .get(currentProject ?? '')
      ?.reflection.map((id) => content.exercisesById.get(id))
      .find((exercise) => exercise !== undefined && !usedExerciseIds.has(exercise.id));
    plan.push(
      staticCandidate(
        'reflect',
        reflection?.concept,
        reflection ? [reflection.id] : [],
        10,
        'Reflect on the project and its evidence.',
      ),
    );
  }
  return toPlan(plan.filter((activity) => activity.plannedMinutes > 0));
}

function planSunday(
  state: SchedulerState,
  content: ContentIndex,
  now: Date,
  budget: number,
): SessionPlan {
  const plan: PlannedActivity[] = [];
  const learnedConceptIds = new Set([
    ...state.mastery
      .filter((record) => masteryRank(record.state) >= masteryRank('assisted'))
      .map((record) => record.conceptId),
    ...(state.lessonRuns ?? [])
      .filter((run) => run.status === 'completed')
      .map((run) => run.conceptId),
  ]);
  const known = [...learnedConceptIds]
    .map((conceptId) => content.conceptsById.get(conceptId))
    .filter((concept): concept is IndexedConcept => Boolean(concept && concept.status !== 'stub'));
  const recallByConcept = (conceptId: string) => {
    const recalls = state.cards
      .filter((card) => card.conceptId === conceptId)
      .flatMap((card) => (typeof card.retrievability === 'number' ? [card.retrievability] : []));
    return recalls.length ? recalls.reduce((sum, recall) => sum + recall, 0) / recalls.length : 1;
  };
  const teachback =
    budget > 40
      ? content.exercises
          .filter(
            (exercise) =>
              exercise.type === 'explain' &&
              learnedConceptIds.has(exercise.concept) &&
              content.conceptsById.get(exercise.concept)?.status !== 'stub' &&
              !(state.usedExerciseIds ?? []).includes(exercise.id),
          )
          .sort(
            (left, right) =>
              recallByConcept(left.concept) - recallByConcept(right.concept) ||
              left.id.localeCompare(right.id),
          )[0]
      : undefined;
  const checkExercises = known
    .map((concept) => chooseExercise(state, content, concept, undefined, ['core', 'transfer'], now))
    .filter(
      (exercise): exercise is IndexedExercise =>
        exercise !== undefined && exercise.id !== teachback?.id,
    );
  const uniqueCheckExercises = [
    ...new Map(checkExercises.map((exercise) => [exercise.id, exercise])).values(),
  ];
  const usedExerciseIds = new Set([
    ...(state.usedExerciseIds ?? []),
    ...(teachback ? [teachback.id] : []),
  ]);
  if (budget > 0 && uniqueCheckExercises.length > 0) {
    plan.push(
      staticCandidate(
        'quick_check',
        undefined,
        uniqueCheckExercises.slice(0, 6).map((item) => item.id),
        Math.min(20, budget),
        'Cumulative independent check.',
      ),
    );
    for (const exercise of uniqueCheckExercises.slice(0, 6)) usedExerciseIds.add(exercise.id);
  }
  if (teachback) {
    plan.push(
      staticCandidate(
        'teachback',
        teachback.concept,
        [teachback.id],
        Math.min(10, budget - 40),
        'Summarize a concept without notes.',
      ),
    );
    usedExerciseIds.add(teachback.id);
  }
  if (budget > 50) {
    const currentProject =
      state.currentProjectId ??
      content.curriculum?.weeks.find((entry) => entry.week === currentLearnerWeek(state, content))
        ?.project;
    const reflection = content.projectsById
      .get(currentProject ?? '')
      ?.reflection.map((id) => content.exercisesById.get(id))
      .find((exercise) => exercise !== undefined && !usedExerciseIds.has(exercise.id));
    plan.push(
      staticCandidate(
        'reflect',
        reflection?.concept,
        reflection ? [reflection.id] : [],
        budget - 50,
        'Review progress and plan the next week.',
      ),
    );
  }
  return toPlan(plan.filter((activity) => activity.plannedMinutes > 0));
}

function staticCandidate(
  kind: ActivityKind,
  conceptId: string | undefined,
  exerciseIds: string[],
  plannedMinutes: number,
  summary: string,
): PlannedActivity {
  return {
    kind,
    ...(conceptId ? { conceptId } : {}),
    exerciseIds,
    plannedMinutes,
    reason: staticReason(summary),
  };
}

function staticReason(summary: string): ActivityReason {
  return { terms: noTerms(), summary };
}

function usesSelectedExercise(candidate: Candidate, selected: Candidate[]): boolean {
  const used = new Set(selected.flatMap((entry) => entry.activity.exerciseIds));
  return candidate.activity.exerciseIds.some((exerciseId) => used.has(exerciseId));
}

function toPlan(candidates: Candidate[] | PlannedActivity[]): SessionPlan {
  const activities = candidates.map((candidate) =>
    'activity' in candidate ? candidate.activity : candidate,
  );
  return { activities, reasons: activities.map((activity) => activity.reason) };
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
