import type { ContentIndex, IndexedConcept, IndexedExercise } from '../content/types.js';
import type { MasteryRecord } from './types.js';
import { masteryRank } from './types.js';

export type SessionKind = 'weekday' | 'saturday' | 'sunday' | 'custom';
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
  | 'diagnostic';

export const SCHEDULER_CONFIG = {
  weights: { goal: 1, week_fit: 1, project: 1, unlock: 1, gap: 1, review: 1, cost: 1 },
  weekday: {
    reviewBudgetRatio: 0.25,
    remediationBudgetRatio: 0.3,
    maxNewConcepts: 2,
    maxActivities: 6,
  },
  repeatWindowDays: 7,
  consolidationMinutes: 5,
  saturdayReviewMinutes: 10,
  saturdayReflectionMinutes: 10,
  sundayCheckMinutes: 20,
  sundayRemediationMinutes: 20,
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
  startDate: string;
  currentProjectId?: string;
  inProgressConceptId?: string;
  actualEstimateRatio?: number;
  usedExerciseIds?: string[];
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

export function currentCurriculumWeek(startDate: string, now: Date): number {
  const elapsedDays = Math.max(0, now.getTime() - Date.parse(startDate)) / 86_400_000;
  return Math.floor(elapsedDays / 7) + 1;
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
  const selectedConcepts = new Set<string>();
  const canAdd = (candidate: Candidate, limit = budget) =>
    selected.length < SCHEDULER_CONFIG.weekday.maxActivities &&
    usedMinutes + candidate.adjustedMinutes <= limit &&
    !usesSelectedExercise(candidate, selected) &&
    (!candidate.activity.conceptId || !selectedConcepts.has(candidate.activity.conceptId));
  const add = (candidate: Candidate, limit = budget) => {
    if (!canAdd(candidate, limit)) return false;
    selected.push(candidate);
    usedMinutes += candidate.adjustedMinutes;
    if (candidate.activity.conceptId) selectedConcepts.add(candidate.activity.conceptId);
    return true;
  };
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
  const remediationCandidates = candidates
    .filter((candidate) => candidate.activity.kind === 'remediate')
    .sort((left, right) => right.score - left.score);
  const remediationCap = Math.floor(budget * SCHEDULER_CONFIG.weekday.remediationBudgetRatio);
  let remediationMinutes = 0;
  for (const candidate of remediationCandidates) {
    if (remediationMinutes + candidate.adjustedMinutes <= remediationCap && canAdd(candidate)) {
      if (add(candidate)) remediationMinutes += candidate.adjustedMinutes;
    }
  }

  const learnCandidates = candidates
    .filter((candidate) => candidate.activity.kind === 'learn')
    .sort((left, right) => {
      if (left.activity.conceptId === state.inProgressConceptId) return -1;
      if (right.activity.conceptId === state.inProgressConceptId) return 1;
      return right.score - left.score;
    });
  let newConceptCount = 0;
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
    add(candidate);
  }

  const otherCandidates = candidates
    .filter(
      (candidate) =>
        !['review', 'remediate', 'learn', 'quick_check'].includes(candidate.activity.kind),
    )
    .sort((left, right) => right.score - left.score);
  for (const candidate of otherCandidates) add(candidate);

  const practiceTarget =
    selected.find((candidate) => candidate.activity.kind === 'learn') ??
    selected.find((candidate) => candidate.activity.kind === 'practice');
  const targetConcept = practiceTarget?.activity.conceptId
    ? content.conceptsById.get(practiceTarget.activity.conceptId)
    : undefined;
  const ratio = Math.min(2, Math.max(0.5, state.actualEstimateRatio ?? 1));
  while (practiceTarget && targetConcept) {
    const exercise = chooseExercise(
      {
        ...state,
        usedExerciseIds: [
          ...(state.usedExerciseIds ?? []),
          ...state.recentAttempts
            .filter(
              (attempt) => daysSince(attempt.createdAt, now) < SCHEDULER_CONFIG.repeatWindowDays,
            )
            .map((attempt) => attempt.exerciseId),
          ...selected.flatMap((candidate) => candidate.activity.exerciseIds),
        ],
      },
      content,
      targetConcept,
      undefined,
      ['core', 'check'],
      now,
    );
    if (!exercise) break;
    const minutes = Math.max(1, Math.ceil(exercise.est_minutes * ratio));
    if (usedMinutes + minutes > budget) break;
    practiceTarget.activity.exerciseIds.push(exercise.id);
    practiceTarget.activity.plannedMinutes += minutes;
    practiceTarget.adjustedMinutes += minutes;
    usedMinutes += minutes;
  }
  return toPlan(selected);
}

function generateCandidates(state: SchedulerState, content: ContentIndex, now: Date): Candidate[] {
  const candidates: Candidate[] = [];
  const week = currentCurriculumWeek(state.startDate, now);
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
      .every((prerequisite) => {
        const prerequisiteConcept = content.conceptsById.get(prerequisite.id);
        return prerequisiteConcept?.dimensions.some((dimension) => {
          const record = masteryByKey.get(masteryKey(prerequisite.id, dimension));
          return (
            record?.inferred ||
            masteryRank(record?.state ?? 'not_assessed') >= masteryRank('assisted')
          );
        });
      });
    const allNotAssessed = states.every((record) => !record || record.state === 'not_assessed');
    const isNew =
      prereqsReady && (allNotAssessed || states.some((record) => record?.state === 'introduced'));
    const isContinuing = states.some(
      (record) => record?.state === 'introduced' || record?.state === 'assisted',
    );
    if (isNew || isContinuing) {
      const dimension = concept.dimensions.find((candidate) => {
        const state = masteryByKey.get(masteryKey(concept.id, candidate))?.state ?? 'not_assessed';
        const hasCoreItem = (content.exercisesByConcept.get(concept.id) ?? []).some(
          (exercise) =>
            exercise.dimension === candidate &&
            (exercise.role === 'core' || exercise.role === 'check'),
        );
        return (
          hasCoreItem &&
          (state === 'introduced' || state === 'assisted' || state === 'not_assessed')
        );
      });
      const exercise = chooseExercise(
        state,
        content,
        concept,
        dimension,
        ['core', 'check'],
        now,
        recentIds,
      );
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

  for (const flag of state.remediationFlags.filter(
    (entry) => (entry.status ?? 'open') === 'open',
  )) {
    const original = content.conceptsById.get(flag.conceptId);
    const prerequisite = flag.targetPrereqId
      ? content.conceptsById.get(flag.targetPrereqId)
      : original?.prereqs
          .filter((entry) => entry.strength === 'hard')
          .map((entry) => content.conceptsById.get(entry.id))
          .filter((entry): entry is IndexedConcept => Boolean(entry))
          .sort(
            (left, right) =>
              conceptStateRank(left, masteryByKey) - conceptStateRank(right, masteryByKey),
          )[0];
    const target =
      prerequisite ??
      (flag.targetPrereqId ? content.conceptsById.get(flag.targetPrereqId) : original);
    if (!target || target.status === 'stub') {
      continue;
    }
    const eligibleDimensions = target.dimensions.filter((dimension) =>
      (content.exercisesByConcept.get(target.id) ?? []).some(
        (exercise) => exercise.dimension === dimension && ['core', 'check'].includes(exercise.role),
      ),
    );
    const dimension =
      eligibleDimensions.sort(
        (left, right) =>
          masteryRank(masteryByKey.get(masteryKey(target.id, left))?.state ?? 'not_assessed') -
          masteryRank(masteryByKey.get(masteryKey(target.id, right))?.state ?? 'not_assessed'),
      )[0] ?? weakestDimension(target, masteryByKey);
    const exercise = chooseExercise(
      state,
      content,
      target,
      dimension,
      ['core', 'check'],
      now,
      recentIds,
    );
    if (exercise) {
      candidates.push(
        makeCandidate(
          state,
          content,
          target,
          'remediate',
          [exercise],
          week,
          project,
          false,
          2,
          `Remediate ${target.title} before continuing ${original?.title ?? flag.conceptId}.`,
        ),
      );
    }
  }

  for (const card of state.cards) {
    if (Date.parse(card.dueAt) > now.getTime()) {
      continue;
    }
    const concept = content.conceptsById.get(card.conceptId);
    if (!concept || concept.status === 'stub') {
      continue;
    }
    const record = masteryByKey.get(masteryKey(card.conceptId, card.dimension));
    const reviewRoles =
      record && masteryRank(record.state) >= masteryRank('independent')
        ? ['transfer', 'review', 'core']
        : ['review', 'core'];
    const exercise = chooseExercise(
      state,
      content,
      concept,
      card.dimension,
      reviewRoles,
      now,
      recentIds,
    );
    if (!exercise) {
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
    const candidate = makeCandidate(state, content, concept, 'review', [exercise], week, project);
    candidate.activity.reason.terms.review = terms.review;
    candidate.score = scoreTerms(candidate.activity.reason.terms, candidate.adjustedMinutes);
    candidate.activity.reason.summary = `Review ${concept.title}; forgetting risk and overdue time shape its priority.`;
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
    summary:
      summary ??
      `${kind === 'learn' ? 'Learn' : kind === 'practice' ? 'Continue' : 'Check'} ${concept.title}.`,
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
    (exercise) => (!dimension || exercise.dimension === dimension) && !used.has(exercise.id),
  );
  for (const role of preferredRoles) {
    const matching = pool.filter((exercise) => exercise.role === role);
    if (matching.length > 0) {
      const fresh = matching.filter((exercise) => !recent.has(exercise.id));
      const candidates = fresh.length > 0 ? fresh : matching;
      return candidates.sort(
        (left, right) => lastSeen(left.id, state) - lastSeen(right.id, state),
      )[0];
    }
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
  } else {
    plan.push(staticCandidate('review', undefined, [], Math.min(10, budget), 'Review warm-up.'));
  }
  const week = currentCurriculumWeek(state.startDate, now);
  const currentProject =
    state.currentProjectId ??
    content.curriculum?.weeks.find((entry) => entry.week === week)?.project ??
    content.projects.find(
      (project) =>
        !state.projectProgress.some(
          (item) => item.projectId === project.id && item.status === 'completed',
        ),
    )?.id;
  if (currentProject && budget > 20) {
    plan.push({
      kind: 'lab',
      projectId: currentProject,
      exerciseIds: [],
      plannedMinutes: Math.max(0, budget - 20),
      reason: staticReason(`Lab activity references project ${currentProject}.`),
    });
  }
  if (budget >= 20) {
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
  const known = state.mastery.filter(
    (record) =>
      content.conceptsById.get(record.conceptId)?.status !== 'stub' &&
      masteryRank(record.state) >= masteryRank('assisted'),
  );
  const checkExercises = known
    .map((record) => content.conceptsById.get(record.conceptId))
    .filter((concept): concept is IndexedConcept => Boolean(concept))
    .map((concept) => chooseExercise(state, content, concept, undefined, ['core', 'transfer'], now))
    .filter((exercise): exercise is IndexedExercise => Boolean(exercise));
  const uniqueCheckExercises = [
    ...new Map(checkExercises.map((exercise) => [exercise.id, exercise])).values(),
  ];
  const usedExerciseIds = new Set(state.usedExerciseIds ?? []);
  if (budget > 0) {
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
  if (budget > 20) {
    const remedial = planSession(
      { ...state, usedExerciseIds: [...usedExerciseIds] },
      content,
      now,
      Math.min(20, budget - 20),
      'custom',
    ).activities.filter((activity) => activity.kind === 'remediate');
    plan.push(...remedial);
    for (const activity of remedial) {
      for (const exerciseId of activity.exerciseIds) usedExerciseIds.add(exerciseId);
    }
  }
  if (budget > 40) {
    const teachback = content.exercises.find(
      (exercise) => exercise.type === 'explain' && !usedExerciseIds.has(exercise.id),
    );
    plan.push(
      staticCandidate(
        'teachback',
        teachback?.concept,
        teachback ? [teachback.id] : [],
        Math.min(10, budget - 40),
        'Summarize a concept without notes.',
      ),
    );
    if (teachback) usedExerciseIds.add(teachback.id);
  }
  if (budget > 50) {
    const currentProject =
      state.currentProjectId ??
      content.curriculum?.weeks.find(
        (entry) => entry.week === currentCurriculumWeek(state.startDate, now),
      )?.project;
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

function conceptStateRank(concept: IndexedConcept, records: Map<string, MasteryRecord>): number {
  return Math.min(
    ...concept.dimensions.map((dimension) =>
      masteryRank(records.get(masteryKey(concept.id, dimension))?.state ?? 'not_assessed'),
    ),
  );
}

function weakestDimension(
  concept: IndexedConcept,
  records: Map<string, MasteryRecord>,
): string | undefined {
  return [...concept.dimensions].sort(
    (left, right) =>
      masteryRank(records.get(masteryKey(concept.id, left))?.state ?? 'not_assessed') -
      masteryRank(records.get(masteryKey(concept.id, right))?.state ?? 'not_assessed'),
  )[0];
}

function lastSeen(exerciseId: string, state: SchedulerState): number {
  const attempt = state.recentAttempts.find((entry) => entry.exerciseId === exerciseId);
  return attempt ? Date.parse(attempt.createdAt) : 0;
}

function daysSince(iso: string, now: Date): number {
  return (now.getTime() - Date.parse(iso)) / 86_400_000;
}

function masteryKey(conceptId: string, dimension: string): string {
  return `${conceptId}:${dimension}`;
}
