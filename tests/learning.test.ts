import { fsrs, generatorParameters, Rating, State } from 'ts-fsrs';
import { beforeAll, expect, test } from 'vitest';
import { loadContent } from '../src/server/content/load.js';
import { isTemplate } from '../src/server/content/templates.js';
import type { ContentIndex } from '../src/server/content/types.js';
import { deriveLearningDebt } from '../src/server/learning/debt.js';
import {
  createDiagnosticState,
  diagnosticComplete,
  markDiagnosticUnassessed,
  nextDiagnosticExercise,
  recordDiagnosticAnswer,
} from '../src/server/learning/diagnostic.js';
import {
  mapReviewRating,
  newReviewCard,
  scheduleInitialReview,
  scheduleReview,
} from '../src/server/learning/fsrs.js';
import { countHintsSincePreviousAttempt } from '../src/server/learning/hints.js';
import {
  calculateCredit,
  DefaultMasteryModel,
  inferPrerequisite,
  recordLessonViewed,
} from '../src/server/learning/mastery.js';
import {
  compareOutlinePosition,
  masteryKey,
  outlinePosition,
  prerequisiteMet,
} from '../src/server/learning/prerequisites.js';
import type { PlannedActivity, SchedulerState } from '../src/server/learning/scheduler.js';
import { planSession, replan, SCHEDULER_CONFIG } from '../src/server/learning/scheduler.js';
import { initialMastery } from '../src/server/learning/types.js';

const now = new Date('2026-01-14T12:00:00.000Z');
let content: ContentIndex;

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Missing fixture ${label}`);
  }
  return value;
}

beforeAll(async () => {
  content = await loadContent('tests/fixtures/content');
});

function emptyState(): SchedulerState {
  return {
    mastery: [],
    cards: [],
    recentAttempts: [],
    remediationFlags: [],
    projectProgress: [],
    startDate: '2026-01-05T00:00:00.000Z',
  };
}

test('mastery credit follows hint, retry, LLM, and self caps', () => {
  expect(
    calculateCredit({ correct: 1, hintsUsed: 0, attemptNo: 1, gradedBy: 'deterministic' }),
  ).toBe(1);
  expect(
    calculateCredit({ correct: 1, hintsUsed: 1, attemptNo: 1, gradedBy: 'deterministic' }),
  ).toBe(0.7);
  expect(
    calculateCredit({ correct: 1, hintsUsed: 2, attemptNo: 2, gradedBy: 'deterministic' }),
  ).toBe(0.25);
  expect(
    calculateCredit({ correct: 1, hintsUsed: 5, attemptNo: 1, gradedBy: 'deterministic' }),
  ).toBe(0.1);
  expect(calculateCredit({ correct: 1, hintsUsed: 0, attemptNo: 1, gradedBy: 'llm' })).toBe(0.5);
  expect(calculateCredit({ correct: 1, hintsUsed: 0, attemptNo: 1, gradedBy: 'self' })).toBe(0.5);
});

test('mastery introduces attempts, requires distinct independent items, and retains delayed recall', () => {
  const model = new DefaultMasteryModel();
  const base = initialMastery('vectors', 'math');
  const first = model.applyAttempt(
    base,
    {
      conceptId: 'vectors',
      dimension: 'math',
      attemptId: 'a1',
      exerciseId: 'vectors-magnitude',
      correct: 1,
      hintsUsed: 0,
      attemptNo: 1,
      mode: 'practice',
      itemRole: 'core',
      gradedBy: 'deterministic',
    },
    now,
  );
  expect(first.mastery.state).toBe('assisted');
  expect(first.event?.rule).toBe('independent_correct_assisted');
  const second = model.applyAttempt(
    first.mastery,
    {
      conceptId: 'vectors',
      dimension: 'math',
      attemptId: 'a2',
      exerciseId: 'vectors-component-sum',
      correct: 1,
      hintsUsed: 0,
      attemptNo: 1,
      mode: 'practice',
      itemRole: 'core',
      gradedBy: 'deterministic',
    },
    now,
  );
  expect(second.mastery.state).toBe('independent');
  expect(second.event?.rule).toBe('two_distinct_independent_items');
  const delayed = model.applyAttempt(
    second.mastery,
    {
      conceptId: 'vectors',
      dimension: 'math',
      attemptId: 'a3',
      exerciseId: 'vectors-magnitude',
      correct: 1,
      hintsUsed: 0,
      attemptNo: 1,
      mode: 'review',
      itemRole: 'review',
      gradedBy: 'deterministic',
    },
    new Date('2026-01-18T12:00:00.000Z'),
  );
  expect(delayed.mastery.state).toBe('retained');
  expect(delayed.event?.rule).toBe('delayed_recall_retained');
});

test('a hinted correct answer also raises introduced mastery to assisted', () => {
  const result = new DefaultMasteryModel().applyAttempt(
    initialMastery('vectors', 'math'),
    {
      conceptId: 'vectors',
      dimension: 'math',
      attemptId: 'hinted-1',
      exerciseId: 'vectors-magnitude',
      correct: 1,
      hintsUsed: 1,
      attemptNo: 1,
      mode: 'practice',
      itemRole: 'core',
      gradedBy: 'deterministic',
    },
    now,
  );

  expect(result.mastery.state).toBe('assisted');
});

test('hint counts reset after the previous attempt and respect activity scope', () => {
  const at = (minute: number) =>
    new Date(`2026-01-14T12:${minute.toString().padStart(2, '0')}:00.000Z`);
  const attempts = [
    {
      userId: 'learner',
      exerciseId: 'item',
      activityId: 'activity-1',
      createdAt: at(1),
    },
    {
      userId: 'learner',
      exerciseId: 'item',
      activityId: 'activity-2',
      createdAt: at(4),
    },
  ];
  const hints = [
    { userId: 'learner', exerciseId: 'item', activityId: 'activity-1', createdAt: at(0) },
    { userId: 'learner', exerciseId: 'item', activityId: 'activity-1', createdAt: at(2) },
    { userId: 'learner', exerciseId: 'item', activityId: 'activity-2', createdAt: at(3) },
    { userId: 'learner', exerciseId: 'item', activityId: 'activity-2', createdAt: at(5) },
    { userId: 'other', exerciseId: 'item', activityId: 'activity-1', createdAt: at(6) },
    { userId: 'learner', exerciseId: 'another-item', activityId: 'activity-1', createdAt: at(6) },
  ];

  expect(
    countHintsSincePreviousAttempt({ userId: 'learner', exerciseId: 'item', attempts, hints }),
  ).toBe(1);
  expect(
    countHintsSincePreviousAttempt({
      userId: 'learner',
      exerciseId: 'item',
      activityId: 'activity-1',
      attempts,
      hints,
    }),
  ).toBe(1);
});

test('diagnostic success is provisional and hard prerequisites are inferred', () => {
  const model = new DefaultMasteryModel();
  const result = model.applyAttempt(
    undefined,
    {
      conceptId: 'matrix-products',
      dimension: 'math',
      attemptId: 'diagnostic-1',
      exerciseId: 'matrix-products-diagnostic',
      correct: 1,
      hintsUsed: 0,
      attemptNo: 1,
      mode: 'diagnostic',
      itemRole: 'diagnostic',
      gradedBy: 'deterministic',
    },
    now,
  );
  expect(result.mastery).toMatchObject({ state: 'independent', provisional: true });
  expect(inferPrerequisite(undefined, 'vectors', 'conceptual', now).mastery.inferred).toBe(true);
  expect(recordLessonViewed(undefined, 'vectors', 'math', now).mastery.state).toBe('introduced');
});

test('independent failure demotes mastery and opens remediation after two failures', () => {
  const model = new DefaultMasteryModel();
  const mastered = {
    ...initialMastery('vectors', 'math'),
    state: 'independent' as const,
    independentItemIds: ['a', 'b'],
    independentDeterministicCount: 2,
    lastIndependentCorrect: true,
  };
  const failed = (attemptId: string) =>
    model.applyAttempt(
      mastered,
      {
        conceptId: 'vectors',
        dimension: 'math',
        attemptId,
        exerciseId: attemptId,
        correct: 0,
        hintsUsed: 0,
        attemptNo: 1,
        mode: 'assessment',
        itemRole: 'core',
        gradedBy: 'deterministic',
      },
      now,
    );
  const first = failed('failure-1');
  expect(first.mastery.state).toBe('assisted');
  expect(first.event?.rule).toBe('independent_failure_demotion');
  const second = model.applyAttempt(
    first.mastery,
    {
      conceptId: 'vectors',
      dimension: 'math',
      attemptId: 'failure-2',
      exerciseId: 'failure-2',
      correct: 0,
      hintsUsed: 0,
      attemptNo: 1,
      mode: 'assessment',
      itemRole: 'core',
      gradedBy: 'deterministic',
    },
    now,
  );
  expect(second.remediationFlagOpen).toBe(true);
  expect(second.remediationReason).toBe('independent_failure_streak');
});

test('FSRS rating mapping never assigns Easy and schedules a review card', () => {
  expect(mapReviewRating({ correct: 0, hintsUsed: 0, attemptNo: 1 })).toBe(1);
  expect(mapReviewRating({ correct: 1, hintsUsed: 1, attemptNo: 1 })).toBe(2);
  expect(mapReviewRating({ correct: 1, hintsUsed: 0, attemptNo: 1 })).toBe(3);
  const card = newReviewCard(now);
  const result = scheduleReview(card, now, 'good', 'UTC', false);
  expect(result.card.reps).toBeGreaterThan(0);
  expect(result.card.due.getTime()).toBeGreaterThan(now.getTime());
});

test('FSRS schedules new cards in day-scale intervals without short-term steps', () => {
  const day = 86_400_000;
  for (const [rating, expectedDays] of [
    ['again', 1],
    ['hard', 2],
    ['good', 3],
  ] as const) {
    const scheduled = scheduleReview(newReviewCard(now), now, rating, 'UTC', false);
    expect(scheduled.card.due.getTime() - now.getTime()).toBe(expectedDays * day);
  }
});

test('reviewing a stored learning-state card schedules at least a day ahead', () => {
  const shortTermScheduler = fsrs(generatorParameters({ enable_fuzz: false }));
  const learning = shortTermScheduler.next(newReviewCard(now), now, Rating.Again).card;
  expect(learning.state).toBe(State.Learning);

  const reviewNow = new Date(now.getTime() + 5 * 60_000);
  const scheduled = scheduleReview(learning, reviewNow, 'good', 'UTC', false);
  expect(scheduled.card.due.getTime()).toBeGreaterThanOrEqual(
    new Date('2026-01-15T00:00:00.000Z').getTime(),
  );
});

test('a newly scheduled review is due no earlier than the next learner calendar day', () => {
  const scheduled = scheduleInitialReview(newReviewCard(now), now, 'good', 'Europe/London', false);
  const dateInZone = (date: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(date);

  expect(scheduled.card.reps).toBeGreaterThan(0);
  expect(scheduled.card.due.getTime()).toBeGreaterThan(now.getTime());
  expect(dateInZone(scheduled.card.due)).not.toBe(dateInZone(now));
});

test('diagnostic ladders interleave domains and move up or down one rung', () => {
  const state = createDiagnosticState(content);
  const math = required(nextDiagnosticExercise(state, content), 'math diagnostic exercise');
  expect(math.id).toBe('dx-vectors');
  const first = recordDiagnosticAnswer(state, math, true, content, now);
  expect(first.state.domains.math?.position).toBe(1);
  expect(first.inferredPrerequisiteIds).toEqual([]);
  const next = required(nextDiagnosticExercise(first.state, content), 'next diagnostic exercise');
  expect(next.id).toBe('dx-loss-functions');
  const second = recordDiagnosticAnswer(first.state, next, false, content, now);
  expect(second.state.domains.ml?.position).toBe(0);
  const skipped = markDiagnosticUnassessed(second.state, 'math', now, content);
  expect(skipped.domains.math?.status).toBe('partially_assessed');
  expect(diagnosticComplete(skipped)).toBe(false);
});

test('skipping a diagnostic domain advances in curriculum ladder order', () => {
  const state = createDiagnosticState(content);
  const reordered = {
    ...state,
    domains: Object.fromEntries(Object.entries(state.domains).reverse()),
  };
  const skipped = markDiagnosticUnassessed(reordered, 'math', now, content);
  expect(nextDiagnosticExercise(skipped, content)?.id).toBe('dx-loss-functions');
});

test('skipping a diagnostic domain after an answer preserves partial evidence', () => {
  const state = createDiagnosticState(content);
  const exercise = required(nextDiagnosticExercise(state, content), 'math diagnostic exercise');
  const answered = recordDiagnosticAnswer(state, exercise, true, content, now).state;
  const skipped = markDiagnosticUnassessed(answered, 'math', now, content);

  expect(skipped.domains.math).toMatchObject({
    answers: 1,
    status: 'partially_assessed',
    correctConceptIds: [exercise.concept],
  });
});

test('learning debt derives implementation gaps, demotions, hints, and open flags', () => {
  const debt = deriveLearningDebt({
    mastery: [
      { ...initialMastery('gradients', 'conceptual'), state: 'independent' },
      { ...initialMastery('gradients', 'implementation'), state: 'introduced' },
    ],
    events: [
      {
        conceptId: 'vectors',
        dimension: 'math',
        fromState: 'independent',
        toState: 'assisted',
        rule: 'independent_failure_demotion',
        createdAt: now.toISOString(),
      },
    ],
    attempts: [
      { conceptId: 'vectors', dimension: 'conceptual', correct: 1, hintsUsed: 2 },
      { conceptId: 'vectors', dimension: 'conceptual', correct: 1, hintsUsed: 2 },
      { conceptId: 'vectors', dimension: 'conceptual', correct: 1, hintsUsed: 2 },
    ],
    remediationFlags: [{ conceptId: 'gradients', targetPrereqId: 'derivatives' }],
  });
  expect(debt.map((entry) => entry.reason)).toEqual(
    expect.arrayContaining([
      'implementation_below_assisted',
      'mastery_demotion',
      'high_hint_dependence',
      'open_remediation',
    ]),
  );
});

test('No-knowledge user gets foundational concepts', () => {
  const plan = planSession(emptyState(), content, now, 60);
  expect(
    plan.activities.some(
      (activity) => activity.kind === 'learn' && activity.conceptId === 'vectors',
    ),
  ).toBe(true);
});

test('learn duration uses the concept estimate', () => {
  const concept = required(content.conceptsById.get('vectors'), 'vectors concept');
  const plan = planSession(emptyState(), content, now, concept.est_minutes);
  const learn = plan.activities.find(
    (activity) => activity.kind === 'learn' && activity.conceptId === concept.id,
  );

  expect(learn?.plannedMinutes).toBe(concept.est_minutes);
});

test('new lessons follow outline order even when a later candidate has a higher score', async () => {
  const fullContent = await loadContent();
  const ids = new Set(['vectors', 'derivatives', 'probability-basics', 'supervised-learning']);
  const probabilityExerciseTemplate = fullContent.exercisesByConcept
    .get('supervised-learning')
    ?.find((exercise) => exercise.dimension === 'conceptual' && exercise.role === 'core');
  if (!probabilityExerciseTemplate) throw new Error('Missing supervised-learning core exercise');
  const probabilityExercise = {
    ...probabilityExerciseTemplate,
    id: 'probability-basics-order-test',
    concept: 'probability-basics',
  };
  const concepts = fullContent.concepts
    .filter((concept) => ids.has(concept.id))
    .map((concept) => {
      if (concept.id === 'supervised-learning') return { ...concept, goal_weight: 100 };
      if (concept.id === 'probability-basics') return { ...concept, status: 'authored' as const };
      return concept;
    });
  const conceptsById = new Map(concepts.map((concept) => [concept.id, concept]));
  const exercises = [
    ...fullContent.exercises.filter((exercise) => ids.has(exercise.concept)),
    probabilityExercise,
  ];
  const curriculum = fullContent.curriculum;
  if (!curriculum) throw new Error('Missing curriculum outline');
  const outlineWeek = curriculum.weeks.find((week) => week.week === 1);
  if (!outlineWeek) throw new Error('Missing first curriculum week');
  const rankedContent: ContentIndex = {
    ...fullContent,
    curriculum: {
      ...curriculum,
      weeks: [
        {
          ...outlineWeek,
          concepts: outlineWeek.concepts.filter((conceptId) => ids.has(conceptId)),
        },
      ],
    },
    concepts,
    conceptsById,
    exercises,
    exercisesById: new Map(exercises.map((exercise) => [exercise.id, exercise])),
    exercisesByConcept: new Map(
      concepts.map((concept) => [
        concept.id,
        concept.id === 'probability-basics'
          ? [probabilityExercise]
          : (fullContent.exercisesByConcept.get(concept.id) ?? []),
      ]),
    ),
    lessons: fullContent.lessons.filter((lesson) => ids.has(lesson.concept)),
    lessonsByConcept: new Map(
      [...fullContent.lessonsByConcept].filter(([conceptId]) => ids.has(conceptId)),
    ),
  };
  const state = emptyState();
  state.mastery = [{ ...initialMastery('vectors', 'conceptual'), inferred: true }];
  const masteryByKey = new Map(
    state.mastery.map((record) => [masteryKey(record.conceptId, record.dimension), record]),
  );
  expect(
    [...ids].every((id) =>
      (conceptsById.get(id)?.prereqs ?? [])
        .filter((prerequisite) => prerequisite.strength === 'hard')
        .every((prerequisite) => prerequisiteMet(prerequisite.id, masteryByKey, [], rankedContent)),
    ),
  ).toBe(true);

  const plansByConcept = new Map(
    [...ids].map((conceptId) => [
      conceptId,
      planSession({ ...state, inProgressConceptId: conceptId }, rankedContent, now, 60),
    ]),
  );
  expect(
    [...plansByConcept].every(([conceptId, plan]) =>
      plan.activities.some(
        (activity) => activity.kind === 'learn' && activity.conceptId === conceptId,
      ),
    ),
  ).toBe(true);
  const plan = planSession(state, rankedContent, now, 60);
  const learnIds = plan.activities
    .filter((activity) => activity.kind === 'learn')
    .map((activity) => activity.conceptId);

  expect(conceptsById.get('supervised-learning')?.goal_weight).toBeGreaterThan(
    conceptsById.get('derivatives')?.goal_weight ?? 0,
  );
  expect(learnIds).toEqual(['vectors', 'derivatives']);
  const score = (activity: PlannedActivity | undefined) => {
    if (!activity) throw new Error('Expected a planned lesson');
    const weighted = Object.entries(activity.reason.terms).reduce(
      (total, [term, value]) =>
        total + value * SCHEDULER_CONFIG.weights[term as keyof typeof SCHEDULER_CONFIG.weights],
      0,
    );
    return weighted / Math.sqrt(activity.plannedMinutes);
  };
  expect(
    score(
      plansByConcept
        .get('supervised-learning')
        ?.activities.find((activity) => activity.conceptId === 'supervised-learning'),
    ),
  ).toBeGreaterThan(
    score(plan.activities.find((activity) => activity.conceptId === 'derivatives')),
  );
});

test('outline positions place missing concepts last', async () => {
  const fullContent = await loadContent();
  expect(outlinePosition('vectors', fullContent)).toEqual([1, 0]);
  expect(compareOutlinePosition('vectors', 'not-in-outline', fullContent)).toBeLessThan(0);
});

test('a completed KP lesson satisfies a prerequisite despite introduced mastery', async () => {
  const fullContent = await loadContent();
  const masteryByKey = new Map([
    [
      masteryKey('supervised-learning', 'conceptual'),
      { ...initialMastery('supervised-learning', 'conceptual'), state: 'introduced' as const },
    ],
  ]);

  expect(
    prerequisiteMet(
      'supervised-learning',
      masteryByKey,
      [{ conceptId: 'supervised-learning', status: 'completed' }],
      fullContent,
    ),
  ).toBe(true);
});

test('unfinished knowledge-point lessons are prioritized regardless of mastery, but completed ones are not relearned', () => {
  const concept = required(content.conceptsById.get('supervised-learning'), 'supervised-learning');
  const base = emptyState();
  base.mastery = [
    ...concept.dimensions.map((dimension) => ({
      ...initialMastery(concept.id, dimension),
      state: 'independent' as const,
    })),
    ...concept.prereqs
      .filter((prerequisite) => prerequisite.strength === 'hard')
      .flatMap((prerequisite) => {
        const requiredConcept = content.conceptsById.get(prerequisite.id);
        return (
          requiredConcept?.dimensions.map((dimension) => ({
            ...initialMastery(prerequisite.id, dimension),
            state: 'independent' as const,
          })) ?? []
        );
      }),
  ];
  for (const status of ['in_progress', 'needs_retry'] as const) {
    const state = {
      ...base,
      lessonRuns: [{ conceptId: concept.id, status }],
    };
    expect(
      planSession(state, content, now, 60).activities.find(
        (activity) => activity.conceptId === concept.id,
      )?.kind,
    ).toBe('learn');
  }
  expect(
    planSession(
      { ...base, lessonRuns: [{ conceptId: concept.id, status: 'completed' }] },
      content,
      now,
      60,
    ).activities.find((activity) => activity.conceptId === concept.id)?.kind,
  ).not.toBe('learn');
});

test('weekday plans avoid duplicate concepts, cap activities, and never add empty fillers', () => {
  const state = emptyState();
  state.cards = [{ conceptId: 'vectors', dimension: 'math', dueAt: '2026-01-14T11:00:00.000Z' }];
  state.mastery = [
    {
      ...initialMastery('vectors', 'math'),
      state: 'independent',
      provisional: true,
    },
  ];
  const plan = planSession(state, content, now, 90);
  const conceptIds = plan.activities
    .map((activity) => activity.conceptId)
    .filter((id): id is string => Boolean(id));

  expect(new Set(conceptIds).size).toBe(conceptIds.length);
  expect(plan.activities.length).toBeLessThanOrEqual(6);
  expect(plan.activities.every((activity) => activity.exerciseIds.length > 0)).toBe(true);
});

test('quick checks are limited to diagnostic-provisional prerequisites of planned learn targets', () => {
  const state = emptyState();
  state.mastery = [
    {
      ...initialMastery('vectors', 'math'),
      state: 'independent',
      provisional: true,
    },
    {
      ...initialMastery('linear-algebra', 'math'),
      state: 'independent',
      provisional: true,
    },
  ];
  const plan = planSession(state, content, now, 60);
  const learnIds = new Set(
    plan.activities
      .filter((activity) => activity.kind === 'learn')
      .map((activity) => activity.conceptId)
      .filter((id): id is string => typeof id === 'string'),
  );
  const prerequisites = new Set(
    [...learnIds].flatMap(
      (id) =>
        content.conceptsById
          .get(id)
          ?.prereqs.filter((prerequisite) => prerequisite.strength === 'hard')
          .map((prerequisite) => prerequisite.id) ?? [],
    ),
  );
  const quickChecks = plan.activities.filter((activity) => activity.kind === 'quick_check');

  expect(learnIds.has('derivatives')).toBe(true);
  expect(quickChecks.length).toBeGreaterThan(0);
  expect(
    quickChecks.every(
      (activity) => activity.conceptId !== undefined && prerequisites.has(activity.conceptId),
    ),
  ).toBe(true);
  expect(quickChecks.every((activity) => activity.reason.summary.includes('before'))).toBe(true);
  expect(quickChecks.some((activity) => activity.conceptId === 'linear-algebra')).toBe(false);
});

test('Knowledgeable user skips mastered prerequisites', () => {
  const state = emptyState();
  const vectors = required(content.conceptsById.get('vectors'), 'vectors concept');
  state.mastery = vectors.dimensions.map((dimension) => ({
    ...initialMastery('vectors', dimension),
    state: 'retained',
  }));
  const plan = planSession(state, content, now, 60);
  expect(
    plan.activities.some(
      (activity) => activity.kind === 'learn' && activity.conceptId === 'vectors',
    ),
  ).toBe(false);
  expect(
    plan.activities.some(
      (activity) => activity.kind === 'learn' && activity.conceptId === 'derivatives',
    ),
  ).toBe(true);
});

test('Scheduler never assigns lessons or practice to stub concepts', () => {
  const stub = required(content.conceptsById.get('matrix-products'), 'stub concept');
  const coreExercise = required(
    content.exercisesByConcept.get('vectors')?.find((exercise) => exercise.role === 'core'),
    'core exercise',
  );
  const stubExercise = {
    ...coreExercise,
    id: 'matrix-products-core',
    concept: stub.id,
  };
  const stubContent = {
    ...content,
    exercises: [...content.exercises, stubExercise],
    exercisesByConcept: new Map(content.exercisesByConcept).set(stub.id, [stubExercise]),
    exercisesById: new Map(content.exercisesById).set(stubExercise.id, stubExercise),
  };
  const state = emptyState();
  const prerequisite = required(content.conceptsById.get('linear-algebra'), 'stub prerequisite');
  state.mastery = prerequisite.dimensions.map((dimension) => ({
    ...initialMastery(prerequisite.id, dimension),
    state: 'retained',
  }));
  state.inProgressConceptId = stub.id;

  const plan = planSession(state, stubContent, now, 60);

  expect(
    plan.activities.some(
      (activity) =>
        activity.conceptId === stub.id &&
        (activity.kind === 'learn' || activity.kind === 'practice'),
    ),
  ).toBe(false);
});

test('Repeated failure triggers remediation targeting the weakest prerequisite', () => {
  const state = emptyState();
  state.remediationFlags = [{ conceptId: 'gradient-descent', targetPrereqId: 'gradients' }];
  state.mastery = [
    { ...initialMastery('gradients', 'math'), state: 'introduced' },
    { ...initialMastery('loss-functions', 'math'), state: 'assisted' },
  ];
  const plan = planSession(state, content, now, 60);
  expect(
    plan.activities.some(
      (activity) => activity.kind === 'remediate' && activity.conceptId === 'gradients',
    ),
  ).toBe(true);
});

test('Independent success outranks hinted success', () => {
  const independent = calculateCredit({
    correct: 1,
    hintsUsed: 0,
    attemptNo: 1,
    gradedBy: 'deterministic',
  });
  const hinted = calculateCredit({
    correct: 1,
    hintsUsed: 2,
    attemptNo: 1,
    gradedBy: 'deterministic',
  });
  expect(independent).toBeGreaterThan(hinted);
});

test('Overdue reviews are scheduled', () => {
  const state = emptyState();
  state.cards = [
    {
      conceptId: 'vectors',
      dimension: 'math',
      dueAt: '2026-01-13T00:00:00.000Z',
      retrievability: 0.7,
    },
  ];
  const review = planSession(state, content, now, 60).activities.find(
    (activity) => activity.kind === 'review',
  );
  expect(review).toBeDefined();
  expect(review?.reason.summary).toContain('Due since 13 Jan 2026');
  expect(review?.reason.summary).toContain('~70% recall');
});

test('due reviews use non-template practice exercises when no higher-priority role exists', () => {
  const practiceOnlyContent: ContentIndex = {
    ...content,
    exercisesByConcept: new Map(content.exercisesByConcept),
  };
  const vectorExercises = content.exercisesByConcept.get('vectors') ?? [];
  const practiceOnlyExercises = vectorExercises.map((exercise) =>
    exercise.dimension === 'math' ? { ...exercise, role: 'practice' as const } : exercise,
  );
  const eligibleIds = new Set(
    practiceOnlyExercises
      .filter(
        (exercise) =>
          exercise.dimension === 'math' && exercise.role === 'practice' && !isTemplate(exercise),
      )
      .map((exercise) => exercise.id),
  );
  practiceOnlyContent.exercisesByConcept.set('vectors', practiceOnlyExercises);
  const state = emptyState();
  state.cards = [
    {
      conceptId: 'vectors',
      dimension: 'math',
      dueAt: new Date(now.getTime() - 86_400_000).toISOString(),
      retrievability: 0.7,
    },
  ];

  const review = planSession(state, practiceOnlyContent, now, 60).activities.find(
    (activity) => activity.kind === 'review',
  );
  const selectedId = review?.exerciseIds[0] ?? '';
  expect(eligibleIds.has(selectedId)).toBe(true);
  expect(
    practiceOnlyExercises.some((exercise) => exercise.id === selectedId && !isTemplate(exercise)),
  ).toBe(true);
});

test('Project prerequisites receive a priority term', () => {
  const state = emptyState();
  const vectors = required(content.conceptsById.get('vectors'), 'vectors concept');
  state.mastery = vectors.dimensions.map((dimension) => ({
    ...initialMastery('vectors', dimension),
    state: 'assisted',
  }));
  state.inProgressConceptId = 'linear-models';
  const plan = planSession(state, content, new Date('2026-01-06T12:00:00.000Z'), 60);
  const prerequisite = plan.activities.find((activity) => activity.conceptId === 'linear-models');
  expect(prerequisite?.reason.terms.project).toBe(3);
  expect(prerequisite?.reason.summary).toContain('needed for the Saturday lab');
  if (prerequisite?.reason.terms.week_fit) {
    expect(prerequisite.reason.summary).toContain('Week 1 focus');
  }
  if (prerequisite?.reason.terms.unlock) {
    expect(prerequisite.reason.summary).toContain('unlocks');
  }
});

test('weekday plan fills at least 80 percent with unseen practice when exercises are eligible', () => {
  const state = emptyState();
  state.mastery = ['vectors', 'linear-algebra'].flatMap((conceptId) => {
    const concept = content.conceptsById.get(conceptId);
    return (concept?.dimensions ?? []).map((dimension) => ({
      ...initialMastery(conceptId, dimension),
      state: 'independent' as const,
      provisional: true,
    }));
  });
  const plan = planSession(state, content, now, 60);
  const plannedMinutes = plan.activities.reduce(
    (sum, activity) => sum + activity.plannedMinutes,
    0,
  );

  expect(
    plan.activities.filter((activity) => activity.kind === 'learn').length,
  ).toBeLessThanOrEqual(2);
  expect(plan.activities.some((activity) => activity.kind === 'learn')).toBe(true);
  expect(plan.activities.some((activity) => activity.kind === 'practice')).toBe(true);
  expect(plannedMinutes).toBeGreaterThanOrEqual(48);
  const practice = plan.activities.find((activity) => activity.kind === 'practice');
  expect(practice?.exerciseIds.length).toBeGreaterThan(0);
  expect(practice?.plannedMinutes).toBeGreaterThan(0);
});

test('Time budget is respected', () => {
  const plan = planSession(emptyState(), content, now, 17);
  expect(
    plan.activities.reduce((sum, activity) => sum + activity.plannedMinutes, 0),
  ).toBeLessThanOrEqual(17);
});

test('Interrupted session resumes its in-progress activity during replanning', () => {
  const inProgress = {
    kind: 'learn' as const,
    conceptId: 'vectors',
    exerciseIds: ['vectors-magnitude'],
    plannedMinutes: 15,
    status: 'in_progress' as const,
    reason: {
      terms: { goal: 3, week_fit: 3, project: 0, unlock: 1, gap: 0, review: 0, cost: -1 },
      summary: 'Resume vectors.',
    },
  };
  const plan = replan(emptyState(), content, now, 20, [inProgress]);
  expect(plan.activities[0]).toMatchObject({ status: 'in_progress', conceptId: 'vectors' });
});

test('Every mastery state change has an evidence event', () => {
  const model = new DefaultMasteryModel();
  const result = model.applyAttempt(
    undefined,
    {
      conceptId: 'vectors',
      dimension: 'math',
      attemptId: 'attempt-1',
      exerciseId: 'vectors-magnitude',
      correct: 0,
      hintsUsed: 0,
      attemptNo: 1,
      mode: 'practice',
      itemRole: 'core',
      gradedBy: 'deterministic',
    },
    now,
  );
  expect(result.event).toMatchObject({
    fromState: 'not_assessed',
    toState: 'introduced',
    attemptId: 'attempt-1',
    rule: 'attempt_introduced',
  });
});

test('Exercise assignment avoids items seen within seven days', () => {
  const state = emptyState();
  state.recentAttempts = [
    {
      conceptId: 'vectors',
      exerciseId: 'vectors-magnitude',
      correct: 1,
      itemRole: 'core',
      createdAt: '2026-01-13T12:00:00.000Z',
    },
  ];
  const plan = planSession(state, content, now, 60);
  const vectors = plan.activities.find(
    (activity) => activity.kind === 'learn' && activity.conceptId === 'vectors',
  );
  expect(vectors?.exerciseIds).not.toContain('vectors-magnitude');
});

test('Saturday allocates a 300-minute lab with a capped review warm-up and reflection', () => {
  const plan = planSession(emptyState(), content, now, 300, 'saturday');
  expect(plan.activities.reduce((sum, activity) => sum + activity.plannedMinutes, 0)).toBe(300);
  expect(
    plan.activities.find((activity) => activity.kind === 'review')?.plannedMinutes ?? 0,
  ).toBeLessThanOrEqual(20);
  expect(plan.activities.some((activity) => activity.kind === 'lab')).toBe(true);
  expect(plan.activities.some((activity) => activity.kind === 'reflect')).toBe(true);
});

test('Saturday plans an extension after a project is complete', () => {
  const state = emptyState();
  state.projectProgress = [{ projectId: 'linreg-numpy', status: 'completed' }];
  const plan = planSession(state, content, now, 300, 'saturday');
  expect(plan.activities.some((activity) => activity.kind === 'lab')).toBe(false);
  expect(
    plan.activities.some(
      (activity) => activity.kind === 'practice' || activity.kind === 'remediate',
    ),
  ).toBe(true);
});

test('Sunday creates a full cumulative assessment plan with interleaved no-hint items', () => {
  const state = emptyState();
  state.mastery = [
    { ...initialMastery('vectors', 'math'), state: 'independent' },
    { ...initialMastery('linear-models', 'conceptual'), state: 'independent' },
  ];
  const plan = planSession(state, content, now, 60, 'sunday');
  const assessment = plan.activities.find((activity) => activity.kind === 'quick_check');
  expect(assessment?.exerciseIds.length).toBeGreaterThan(0);
  expect(plan.activities.reduce((sum, activity) => sum + activity.plannedMinutes, 0)).toBe(60);
});
