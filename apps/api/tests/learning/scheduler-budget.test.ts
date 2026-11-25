import type { ContentIndex } from '@academy/aesop/course/types';
import { newReviewCard, scheduleReview } from '@academy/aesop/memory/fsrs';
import { initialMastery } from '@academy/aesop/memory/types';
import type { SchedulerState } from '@academy/aesop/planner/scheduler';
import {
  dueTopicsCoveredBy,
  explainReviewSelection,
  explainReviewSelectionForReplan,
  planSession,
  sessionBudget,
} from '@academy/aesop/planner/scheduler';
import { Rating, State } from 'ts-fsrs';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadContent } from '../../src/content/load.js';

const now = new Date('2026-01-14T12:00:00.000Z');
let fixtureContent: ContentIndex;

beforeAll(async () => {
  fixtureContent = await loadContent('tests/fixtures/content');
});

function plannerState(
  content: ContentIndex,
  options: {
    activeCourseId?: string | null;
    studyCourseIds?: string[];
    freshConceptId?: string;
    cards?: SchedulerState['cards'];
  } = {},
): SchedulerState {
  return {
    timezone: 'UTC',
    activeCourseId:
      options.activeCourseId === undefined ? 'fixture-course' : options.activeCourseId,
    studyCourseIds: options.studyCourseIds ?? ['fixture-course'],
    recentLearnMinutesByConcept: {},
    mastery: content.concepts.flatMap((concept) =>
      concept.id === options.freshConceptId
        ? []
        : concept.dimensions.map((dimension) => ({
            ...initialMastery(concept.id, dimension),
            state: 'independent' as const,
          })),
    ),
    cards: options.cards ?? [],
    reviewedTodayConceptIds: [],
    recentAttempts: [],
    remediationFlags: [],
    projectProgress: [],
    completedPaperIds: [],
    startDate: '2026-01-05T00:00:00.000Z',
  };
}

function reviewCard(conceptId: string, dueAt: Date): SchedulerState['cards'][number] {
  const reviewedAt = new Date('2025-12-01T12:00:00.000Z');
  return {
    conceptId,
    dimension: 'math',
    dueAt: dueAt.toISOString(),
    fsrs: {
      ...scheduleReview(newReviewCard(reviewedAt), reviewedAt, Rating.Good, 'UTC', false).card,
      state: State.Review,
      stability: 30,
      due: dueAt,
    },
  };
}

function lessonCrowdingContent(
  coversVectors = false,
  linearModelReviewMinutes?: number,
): ContentIndex {
  const concepts = fixtureContent.concepts.map((concept) =>
    concept.id === 'supervised-learning'
      ? {
          ...concept,
          est_minutes: 15,
          encompassings: [
            ...(concept.encompassings ?? []).filter(({ id }) => id !== 'vectors'),
            ...(coversVectors ? [{ id: 'vectors', weight: 1 }] : []),
          ],
        }
      : concept,
  );
  const exercises = fixtureContent.exercises.map((exercise) =>
    exercise.concept === 'vectors' && exercise.dimension === 'math'
      ? { ...exercise, est_minutes: 3 }
      : exercise.concept === 'linear-models' &&
          exercise.dimension === 'math' &&
          linearModelReviewMinutes !== undefined
        ? { ...exercise, est_minutes: linearModelReviewMinutes }
        : exercise,
  );
  const exercisesById = new Map(exercises.map((exercise) => [exercise.id, exercise]));
  const updateExercises = (items: typeof exercises) =>
    items.map((exercise) => exercisesById.get(exercise.id) ?? exercise);
  return {
    ...fixtureContent,
    concepts,
    conceptsById: new Map(concepts.map((concept) => [concept.id, concept])),
    exercises,
    exercisesById,
    exercisesByConcept: new Map(
      [...fixtureContent.exercisesByConcept].map(([conceptId, items]) => [
        conceptId,
        updateExercises(items),
      ]),
    ),
    exercisesByRole: new Map(
      [...fixtureContent.exercisesByRole].map(([role, items]) => [role, updateExercises(items)]),
    ),
  };
}

function mixedFallbackContent(): ContentIndex {
  const content = lessonCrowdingContent(true, 8);
  const concepts = content.concepts.map((concept) => {
    if (concept.id === 'supervised-learning') {
      return {
        ...concept,
        encompassings: (concept.encompassings ?? []).map((link) =>
          link.id === 'vectors' ? { ...link, weight: 0.02 } : link,
        ),
      };
    }
    if (concept.id === 'vectors') {
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
  return {
    ...content,
    concepts,
    conceptsById: new Map(concepts.map((concept) => [concept.id, concept])),
  };
}

describe('sessionBudget', () => {
  it('uses configurable weekday and weekend defaults', () => {
    expect(sessionBudget('weekday')).toBe(60);
    expect(sessionBudget('saturday')).toBe(300);
    expect(sessionBudget('sunday')).toBe(60);
    expect(sessionBudget('weekday', { scheduleMinutes: 45 })).toBe(45);
    expect(sessionBudget('saturday', { saturdayMinutes: 240 })).toBe(240);
    expect(sessionBudget('sunday', { sundayMinutes: 75 })).toBe(75);
  });
});

it('uses completed failed-quiz lessons in the replan explanation exclusions', () => {
  const content = lessonCrowdingContent(true);
  const state = plannerState(content, { cards: [reviewCard('vectors', now)] });
  state.lessonRuns = [
    {
      conceptId: 'supervised-learning',
      status: 'needs_retry',
      retryAfter: new Date('2026-01-12T12:00:00.000Z'),
    },
  ];
  const failedQuizActivity = {
    kind: 'learn' as const,
    conceptId: 'supervised-learning',
    exerciseIds: [],
    plannedMinutes: 15,
    status: 'completed' as const,
    reason: {
      terms: { goal: 0, week_fit: 0, project: 0, unlock: 0, gap: 0, review: 0, cost: 0 },
      summary: 'completed lesson with a failed quiz',
    },
  };

  const explained = explainReviewSelectionForReplan(state, content, now, 20, [failedQuizActivity]);
  const withoutExclusions = explainReviewSelection(state, content, now, 20);
  const withoutExclusionDecision = withoutExclusions.find(
    ({ conceptId }) => conceptId === 'vectors',
  );
  const replanDecision = explained.results.find(({ conceptId }) => conceptId === 'vectors');

  expect(explained.excludedLearnConceptIds).toEqual(['supervised-learning']);
  expect(withoutExclusionDecision?.coveringConceptId).toBe('supervised-learning');
  expect(replanDecision?.coveringConceptId).not.toBe('supervised-learning');
});

describe('review budget reservation', () => {
  it('reserves the only due review before an unrelated fresh lesson uses the budget', () => {
    const content = lessonCrowdingContent();
    const state = plannerState(content, {
      freshConceptId: 'supervised-learning',
      cards: [reviewCard('vectors', now)],
    });

    const plan = planSession(state, content, now, 20);
    const review = plan.activities.find((activity) => activity.kind === 'review');

    expect(review?.conceptId).toBe('vectors');
    expect(review?.plannedMinutes).toBeGreaterThan(6);
    expect(plan.activities.some((activity) => activity.kind === 'learn')).toBe(false);
    expect(
      plan.activities.reduce((total, activity) => total + activity.plannedMinutes, 0),
    ).toBeLessThanOrEqual(20);

    const fitBudget = (review?.plannedMinutes ?? 0) + 15;
    const fitPlan = planSession(state, content, now, fitBudget);

    expect(
      fitPlan.activities.some(
        (activity) => activity.kind === 'learn' && activity.conceptId === 'supervised-learning',
      ),
    ).toBe(true);
    expect(fitPlan.activities.some((activity) => activity.kind === 'review')).toBe(true);
  });

  it('includes a rejected review candidate’s adjusted minutes in its explanation', () => {
    const state = plannerState(fixtureContent, {
      activeCourseId: null,
      studyCourseIds: [],
      cards: [reviewCard('vectors', now), reviewCard('linear-models', now)],
    });
    const explanation = explainReviewSelection(state, fixtureContent, now, 1);
    const rejected = explanation.find(
      (item) => item.result === 'rejected:reviewMinuteCap' || item.result === 'rejected:budget',
    );

    expect(rejected).toBeDefined();
    expect(rejected?.candidateMinutes).toBeGreaterThan(0);
  });

  it('releases the fallback review reservation when a lesson covers that topic', () => {
    const content = lessonCrowdingContent(true);
    const state = plannerState(content, {
      freshConceptId: 'supervised-learning',
      cards: [reviewCard('vectors', now)],
    });

    const plan = planSession(state, content, now, 20);
    const lesson = plan.activities.find(
      (activity) => activity.kind === 'learn' && activity.conceptId === 'supervised-learning',
    );
    const explanation = explainReviewSelection(state, content, now, 20);

    expect(lesson?.plannedMinutes).toBe(15);
    expect(plan.activities.some((activity) => activity.kind === 'review')).toBe(false);
    expect(explanation).toContainEqual(
      expect.objectContaining({
        conceptId: 'vectors',
        result: 'covered',
        coveringConceptId: 'supervised-learning',
      }),
    );
  });

  it('plans the focused lesson before reserving a due review it covers', () => {
    const content = lessonCrowdingContent(true);
    const state = plannerState(content, {
      freshConceptId: 'supervised-learning',
      cards: [reviewCard('vectors', now)],
    });
    state.inProgressConceptId = 'supervised-learning';

    const unforcedPlan = planSession(state, content, now, 10);
    expect(
      unforcedPlan.activities.some(
        (activity) => activity.kind === 'learn' && activity.conceptId === 'supervised-learning',
      ),
    ).toBe(false);
    expect(unforcedPlan.activities.some((activity) => activity.kind === 'review')).toBe(true);

    const focusedPlan = planSession(state, content, now, 10, 'weekday', new Set(), new Set(), {
      focusConceptId: 'supervised-learning',
    });
    const focusLesson = focusedPlan.activities[0];

    expect(focusLesson).toEqual(
      expect.objectContaining({
        kind: 'learn',
        conceptId: 'supervised-learning',
        plannedMinutes: 15,
      }),
    );
    expect(focusedPlan.activities.some((activity) => activity.kind === 'review')).toBe(false);
  });

  it('keeps a fallback review when a lesson covers only one of its due topics', () => {
    const content = mixedFallbackContent();
    const vectorsCard = reviewCard('vectors', now);
    vectorsCard.retrievability = 0.1;
    const linearModelsCard = reviewCard('linear-models', now);
    linearModelsCard.retrievability = 0.9;
    const state = plannerState(content, {
      freshConceptId: 'supervised-learning',
      cards: [vectorsCard, linearModelsCard],
    });

    expect(dueTopicsCoveredBy('supervised-learning', state, content, now)).toEqual(
      new Set(['vectors']),
    );
    expect(dueTopicsCoveredBy('vectors', state, content, now)).toEqual(new Set(['linear-models']));

    const plan = planSession(state, content, now, 20);
    const review = plan.activities.find((activity) => activity.kind === 'review');

    expect(
      plan.activities.some(
        (activity) => activity.kind === 'learn' && activity.conceptId === 'supervised-learning',
      ),
    ).toBe(false);
    expect(review?.conceptId).toBe('vectors');
  });

  it('requires an early review to cover two uncovered due topics', () => {
    const concepts = fixtureContent.concepts.map((concept) =>
      concept.id === 'linear-models'
        ? { ...concept, encompassings: [{ id: 'vectors', weight: 1 }] }
        : concept,
    );
    const content = {
      ...fixtureContent,
      concepts,
      conceptsById: new Map(concepts.map((concept) => [concept.id, concept])),
    };
    const dueVectorCard = reviewCard('vectors', now);
    dueVectorCard.retrievability = 0.9;
    const advancedReviewCard = reviewCard('linear-models', new Date('2026-02-01T00:00:00.000Z'));
    advancedReviewCard.retrievability = 0.1;
    const state = plannerState(content, {
      activeCourseId: null,
      studyCourseIds: [],
      cards: [dueVectorCard, advancedReviewCard],
    });

    const plan = planSession(state, content, now, 60);
    const selectedReviewConcepts = new Set(
      plan.activities
        .filter((activity) => activity.kind === 'review')
        .flatMap((activity) =>
          activity.exerciseIds.flatMap((exerciseId) => {
            const conceptId = content.exercisesById.get(exerciseId)?.concept;
            return conceptId ? [conceptId] : [];
          }),
        ),
    );

    expect(selectedReviewConcepts).toEqual(new Set(['vectors']));
    expect(explainReviewSelection(state, content, now, 60)).toContainEqual(
      expect.objectContaining({ conceptId: 'vectors', result: 'selected' }),
    );
  });
});
