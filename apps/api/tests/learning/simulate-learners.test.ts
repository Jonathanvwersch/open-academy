import { type Card, Rating, State } from 'ts-fsrs';
import { afterAll, expect, test } from 'vitest';
import {
  attributeActivityLogs,
  auditP11DescendantCard,
  auditP15Trace,
  type InvariantId,
  newActivitiesForReplan,
  p5HasNoWorkWindow,
  p6HasFeasibleOverdueReview,
  p10EligibleConceptIds,
  p10MissingOverdueRetryConcepts,
  p10PreservedActivityMinutes,
  p10RetryFitsCapacity,
  p10SchedulerPriorityLessonMinutes,
  p13HasEmptyPlanViolation,
  p14UncoveredDueCards,
  p16HasOverduePrecedenceViolation,
  p17ReviewFitsRemaining,
  p18HasMissedPickup,
  p18PlanCoversTopic,
  p19HasEarlyReviewViolation,
  planUsageMinutes,
  renderMarkdownReport,
  requireP17ReviewMinutes,
  reviewFeasible,
  SimulatedApiFailureError,
  type SimulationProfile,
  scenarioCourseFilterSkipReason,
  selectedReviewConceptsForAudit,
  simulateLearners,
} from '../../scripts/learner-simulator.js';
import { env } from '../../src/config.js';
import { loadContent } from '../../src/content/load.js';
import { createDb } from '../../src/db/client.js';
import { newReviewCard, scheduleReview } from '../../src/learning/fsrs.js';
import { implicitRepetition } from '../../src/learning/implicit-repetition.js';
import type { SchedulerState } from '../../src/learning/scheduler.js';

const db = createDb(env.TEST_DATABASE_URL);
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

const p11Weights = {
  weight: (conceptId: string, ancestorId: string) =>
    conceptId === 'prerequisite' && ancestorId === 'descendant'
      ? 0.5
      : conceptId === 'credit-source' && ancestorId === 'descendant'
        ? 0.25
        : 0,
};

const p15Weights = {
  weight: (sourceConceptId: string, targetConceptId: string) => {
    if (sourceConceptId === targetConceptId) return 1;
    if (sourceConceptId === 'child' && targetConceptId === 'parent') return 0.5;
    if (sourceConceptId === 'descendant' && targetConceptId === 'prerequisite') return 0.5;
    if (sourceConceptId === 'prerequisite' && targetConceptId === 'descendant') return 0.25;
    return 0;
  },
  ancestors: (sourceConceptId: string) =>
    sourceConceptId === 'child' ? new Map([['parent', 0.5]]) : new Map(),
  descendants: (sourceConceptId: string) =>
    sourceConceptId === 'prerequisite' ? new Map([['descendant', 0.5]]) : new Map(),
};

function p11Card(dueAt: string, lastReviewAt: string | null) {
  return {
    id: 'descendant-card',
    dueAt: new Date(dueAt),
    lastReviewAt: lastReviewAt ? new Date(lastReviewAt) : null,
    fsrs: { stability: 3, difficulty: 5 },
  };
}

function p11Counters() {
  return { p11CheckedEvents: 0, p11AmbiguousEvents: 0 };
}

function p15Card(id: string, conceptId: string, dueAt: string, lastReviewAt: string | null = null) {
  const reviewedAt = new Date('2025-12-01T12:00:00.000Z');
  const due = new Date(dueAt);
  return {
    id,
    conceptId,
    dueAt: due,
    lastReviewAt: lastReviewAt ? new Date(lastReviewAt) : null,
    fsrs: {
      ...scheduleReview(newReviewCard(reviewedAt), reviewedAt, Rating.Good, 'UTC', false).card,
      state: State.Review,
      stability: 30,
      due,
    },
  };
}

function applyExpectedImplicitCredit(
  card: {
    id: string;
    conceptId: string;
    dueAt: Date;
    lastReviewAt: Date | null;
    fsrs: Card;
  },
  rating: Rating,
  weight: number,
  now: Date,
) {
  const result = implicitRepetition(
    { fsrs: card.fsrs, dueAt: card.dueAt },
    { weight, rating, now, timeZone: 'UTC', enableFuzz: false },
  );
  return result ? { ...card, fsrs: result.fsrs, dueAt: result.dueAt } : card;
}

function p15TraceEvent(
  sourceConceptId: string,
  rating: Rating,
  target: ReturnType<typeof p15Card>,
  weight: number,
  now: Date,
  activityOrder: number | null = 0,
) {
  const before = { dueAt: target.dueAt, fsrs: target.fsrs };
  const result = implicitRepetition(before, {
    weight,
    rating,
    now,
    timeZone: 'UTC',
    enableFuzz: false,
  });
  const after = result ?? before;
  return {
    sourceConceptId,
    rating,
    targetCardId: target.id,
    weight,
    before: {
      ...before,
      stability: before.fsrs.stability,
      difficulty: before.fsrs.difficulty,
    },
    after: { ...after, stability: after.fsrs.stability, difficulty: after.fsrs.difficulty },
    applied: result !== undefined,
    activityOrder,
  };
}

function stripWallClockFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripWallClockFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !['generatedAt', 'duration', 'durationMs', 'elapsedMs', 'runtimeMs'].includes(key),
      )
      .map(([key, entry]) => [key, stripWallClockFields(entry)]),
  );
}

afterAll(async () => {
  await db.$client.end();
});

test('P11 flags a later due date after an Again with no same-activity credit', () => {
  const counters = p11Counters();
  const assessment = auditP11DescendantCard(
    counters,
    'descendant',
    p11Card('2026-01-01T00:00:00.000Z', null),
    p11Card('2026-01-02T00:00:00.000Z', null),
    [{ cardId: 'prerequisite-card', conceptId: 'prerequisite', rating: '1' }],
    p11Weights,
  );

  expect(assessment).toEqual({ kind: 'checked', fiReChanged: true, violates: true });
  expect(counters).toEqual({ p11CheckedEvents: 1, p11AmbiguousEvents: 0 });
});

test('P11 skips a descendant card explicitly reviewed in the same activity', () => {
  const counters = p11Counters();
  const assessment = auditP11DescendantCard(
    counters,
    'descendant',
    p11Card('2026-01-01T00:00:00.000Z', '2025-12-31T00:00:00.000Z'),
    p11Card('2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
    [
      { cardId: 'prerequisite-card', conceptId: 'prerequisite', rating: '1' },
      { cardId: 'descendant-card', conceptId: 'descendant', rating: '2' },
    ],
    p11Weights,
  );

  expect(assessment).toEqual({ kind: 'explicit' });
  expect(counters).toEqual({ p11CheckedEvents: 0, p11AmbiguousEvents: 0 });
});

test('P11 counts positive same-activity credit as ambiguous instead of flagging it', () => {
  const counters = p11Counters();
  const assessment = auditP11DescendantCard(
    counters,
    'descendant',
    p11Card('2026-01-01T00:00:00.000Z', null),
    p11Card('2026-01-02T00:00:00.000Z', null),
    [
      { cardId: 'prerequisite-card', conceptId: 'prerequisite', rating: '1' },
      { cardId: 'credit-source-card', conceptId: 'credit-source', rating: '3' },
    ],
    p11Weights,
  );

  expect(assessment).toEqual({ kind: 'ambiguous' });
  expect(counters).toEqual({ p11CheckedEvents: 0, p11AmbiguousEvents: 1 });
});

test('P11 does not treat mixed ratings with an Again as positive credit', () => {
  const counters = p11Counters();
  const assessment = auditP11DescendantCard(
    counters,
    'descendant',
    p11Card('2026-01-01T00:00:00.000Z', null),
    p11Card('2026-01-02T00:00:00.000Z', null),
    [
      { cardId: 'prerequisite-card', conceptId: 'prerequisite', rating: '1' },
      { cardId: 'credit-source-again-card', conceptId: 'credit-source', rating: '1' },
      { cardId: 'credit-source-good-card', conceptId: 'credit-source', rating: '3' },
    ],
    p11Weights,
  );

  expect(assessment).toEqual({ kind: 'checked', fiReChanged: true, violates: true });
  expect(counters).toEqual({ p11CheckedEvents: 1, p11AmbiguousEvents: 0 });
});

test('P13 flags an empty plan only when an unlocked lesson fits its budget', () => {
  expect(p13HasEmptyPlanViolation(0, [15], 20)).toBe(true);
  expect(p13HasEmptyPlanViolation(0, [25], 20)).toBe(false);
  expect(p13HasEmptyPlanViolation(1, [15], 20)).toBe(false);
});

test('P5 requires seven days without lesson, review, or remedial attempts', () => {
  const days = Array.from({ length: 7 }, (_, index) => ({
    day: index + 1,
    lessons: 0,
    reviewAttempts: 0,
  }));

  expect(p5HasNoWorkWindow(days, 7, new Set())).toBe(true);
  expect(
    p5HasNoWorkWindow(
      days.map((item, index) => ({
        ...item,
        lessons: index === 3 ? 1 : 0,
      })),
      7,
      new Set(),
    ),
  ).toBe(false);
  expect(p5HasNoWorkWindow(days, 7, new Set([7]))).toBe(false);
});

test('P10 flags omitted retries after the scheduler two-day priority threshold', () => {
  const now = new Date('2026-01-14T12:00:00.000Z');
  const state = {
    lessonRuns: [
      {
        conceptId: 'overdue',
        status: 'needs_retry',
        retryAfter: new Date('2026-01-12T12:00:00.000Z'),
      },
      {
        conceptId: 'ready',
        status: 'needs_retry',
        retryAfter: new Date('2026-01-13T12:00:00.000Z'),
      },
      {
        conceptId: 'blocked',
        status: 'needs_retry',
        retryAfter: new Date('2026-01-10T12:00:00.000Z'),
      },
    ],
    remediationFlags: [{ conceptId: 'blocked', status: 'open' }],
  } as unknown as SchedulerState;
  const eligible = new Set(['overdue', 'ready', 'blocked']);
  expect(p10MissingOverdueRetryConcepts(state, eligible, new Set(), now)).toEqual(['overdue']);
  expect(p10MissingOverdueRetryConcepts(state, eligible, new Set(['overdue']), now)).toEqual([]);
});

test('P10 ignores a case-1 retry that cannot fit after preserved in-progress work', () => {
  const now = new Date('2026-01-14T12:00:00.000Z');
  const state = {
    lessonRuns: [
      {
        conceptId: 'probability-basics',
        status: 'needs_retry',
        retryAfter: new Date('2026-01-12T12:00:00.000Z'),
      },
    ],
    remediationFlags: [],
  } as unknown as SchedulerState;
  const eligible = new Set(['probability-basics']);

  expect(p10RetryFitsCapacity(30, 20, 20, 0, 0)).toBe(false);
  expect(
    p10MissingOverdueRetryConcepts(
      state,
      eligible,
      new Set(),
      now,
      new Map([['probability-basics', false]]),
    ),
  ).toEqual([]);
});

test('P10 flags a fitting overdue retry displaced by a lower-priority lesson', () => {
  const now = new Date('2026-01-14T12:00:00.000Z');
  const state = {
    lessonRuns: [
      {
        conceptId: 'what-is-ml',
        status: 'needs_retry',
        retryAfter: new Date('2026-01-12T12:00:00.000Z'),
      },
    ],
    remediationFlags: [],
  } as unknown as SchedulerState;
  const eligible = new Set(['what-is-ml']);
  const firstActivity = {
    id: 'fresh-first-activity',
    kind: 'learn',
    conceptId: 'new-lesson',
    plannedMinutes: 30,
    status: 'in_progress',
  } as const;
  const carriedOverActivityIds = new Set<string>();
  const preservedMinutes = p10PreservedActivityMinutes([firstActivity], carriedOverActivityIds);

  expect(preservedMinutes).toBe(0);
  expect(p10RetryFitsCapacity(15, 60, preservedMinutes, 5, 0)).toBe(true);
  expect(
    p10MissingOverdueRetryConcepts(
      state,
      eligible,
      new Set([firstActivity.conceptId]),
      now,
      new Map([['what-is-ml', true]]),
    ),
  ).toEqual(['what-is-ml']);
});

test('P10 honors resumed lesson priority over a fitting overdue retry', () => {
  const now = new Date('2026-01-14T12:00:00.000Z');
  const state = {
    lessonRuns: [
      { conceptId: 'resumed-lesson', status: 'quiz' },
      {
        conceptId: 'retry-peer',
        status: 'needs_retry',
        retryAfter: new Date('2026-01-12T12:00:00.000Z'),
      },
    ],
    remediationFlags: [],
  } as unknown as SchedulerState;
  const activities = [
    {
      id: 'fresh-lesson',
      kind: 'learn',
      conceptId: 'fresh-lesson',
      plannedMinutes: 30,
      exerciseIds: [],
      status: 'in_progress',
    },
    {
      id: 'resumed-lesson',
      kind: 'learn',
      conceptId: 'resumed-lesson',
      plannedMinutes: 30,
      exerciseIds: [],
      status: 'in_progress',
    },
    {
      id: 'retry-peer',
      kind: 'learn',
      conceptId: 'retry-peer',
      plannedMinutes: 20,
      exerciseIds: [],
      status: 'in_progress',
    },
  ] as unknown as Parameters<typeof p10SchedulerPriorityLessonMinutes>[3];

  const priority = p10SchedulerPriorityLessonMinutes(
    state,
    'overdue-retry',
    now,
    activities,
    new Set(),
  );

  expect(priority).toEqual({
    overdueRetryMinutes: 20,
    resumedLessonMinutes: 30,
    focusLessonMinutes: 0,
    totalMinutes: 50,
  });
  expect(p10RetryFitsCapacity(20, 60, 0, 5, priority.totalMinutes)).toBe(true);
  expect(p10RetryFitsCapacity(20, 45, 0, 14, priority.totalMinutes)).toBe(false);
});

test('P10 includes ready lesson topics beyond the first five course choices', async () => {
  const content = await loadContent();
  const conceptIds = [...content.lessonsByConcept.keys()]
    .filter((conceptId) => content.conceptsById.get(conceptId)?.status !== 'stub')
    .slice(0, 6);
  const sixthConceptId = conceptIds[5];
  const sourceCourse = content.coursesById.get('maths-for-ml');
  const sourceUnit = sourceCourse?.units[0];
  if (!sixthConceptId || !sourceCourse || !sourceUnit) {
    throw new Error('Expected six lesson topics and a course unit');
  }

  const conceptsById = new Map(content.conceptsById);
  for (const conceptId of conceptIds) {
    const concept = conceptsById.get(conceptId);
    if (concept) conceptsById.set(conceptId, { ...concept, prereqs: [] });
  }
  const coursesById = new Map(content.coursesById);
  coursesById.set('p10-test-course', {
    ...sourceCourse,
    id: 'p10-test-course',
    units: [{ ...sourceUnit, concepts: conceptIds }],
  });
  const testContent = { ...content, conceptsById, coursesById };
  const now = new Date('2026-01-14T12:00:00.000Z');
  const state = {
    activeCourseId: 'p10-test-course',
    studyCourseIds: ['p10-test-course'],
    mastery: [],
    remediationFlags: [],
    lessonRuns: conceptIds.map((conceptId) => ({
      conceptId,
      status: 'needs_retry',
      retryAfter: new Date('2026-01-12T12:00:00.000Z'),
    })),
  } as unknown as SchedulerState;

  const eligibleConceptIds = p10EligibleConceptIds(state, testContent, now);

  expect(eligibleConceptIds.size).toBe(6);
  expect(eligibleConceptIds.has(sixthConceptId)).toBe(true);
  expect(conceptIds.slice(0, 5)).not.toContain(sixthConceptId);
});

test('P18 counts an over-cap scheduled review when it is at least two days overdue', () => {
  const review = [{ kind: 'review', status: 'planned' }] as const;
  expect(p18PlanCoversTopic(review, 9, 20, 3, 2)).toBe(true);
  expect(p18PlanCoversTopic(review, 9, 20, 3, 1)).toBe(false);
});

test('replan budget accounting does not charge preserved in-progress activities twice', () => {
  const activities = [
    { kind: 'review', status: 'in_progress', plannedMinutes: 5 },
    { kind: 'learn', status: 'planned', plannedMinutes: 10 },
  ] as const;
  expect(planUsageMinutes(activities, true)).toEqual({
    usedMinutes: 10,
    usedReviewMinutes: 0,
  });
  expect(planUsageMinutes(activities, false)).toEqual({
    usedMinutes: 15,
    usedReviewMinutes: 5,
  });
});

test('replan includes a newly inserted in-progress prerequisite review once', () => {
  const activities = [
    { id: 'preserved', status: 'in_progress' },
    { id: 'inserted-prerequisite', status: 'in_progress' },
    { id: 'new-planned', status: 'planned' },
    { id: 'completed', status: 'completed' },
  ] as const;
  expect(
    newActivitiesForReplan(activities, new Set(['preserved', 'completed'])).map(({ id }) => id),
  ).toEqual(['inserted-prerequisite', 'new-planned']);
});

test('scripted scenarios are skipped and reported when their fixture course is filtered out', () => {
  expect(
    scenarioCourseFilterSkipReason('scenario-p14-fallback', ['course-a'], 'fixture-course'),
  ).toBe('fixture course fixture-course is not included in --courses');
  expect(
    scenarioCourseFilterSkipReason('scenario-p14-fallback', ['fixture-course'], 'fixture-course'),
  ).toBeUndefined();
  expect(scenarioCourseFilterSkipReason('average', ['course-a'], 'fixture-course')).toBeUndefined();
});

test('P14 checks selected and covered cards while excluding cap- and budget-rejected cards', () => {
  const explanations = [
    {
      conceptId: 'covered',
      result: 'covered' as const,
      coveringConceptId: 'lesson',
      exerciseIds: [],
      exerciseDimensions: ['math'],
      reviewMinutes: 8,
      reviewCap: 6,
      usedMinutes: 12,
      budget: 20,
      plannedActivityCount: 2,
    },
    {
      conceptId: 'selected',
      result: 'selected' as const,
      exerciseIds: [],
      exerciseDimensions: ['math'],
      reviewMinutes: 4,
      reviewCap: 6,
      usedMinutes: 12,
      budget: 20,
      plannedActivityCount: 2,
    },
    {
      conceptId: 'dropped',
      result: 'rejected:budget' as const,
      exerciseIds: [],
      exerciseDimensions: ['math'],
      reviewMinutes: 8,
      reviewCap: 6,
      usedMinutes: 20,
      budget: 20,
      plannedActivityCount: 2,
    },
  ];
  const dueCards = [
    { cardId: 'covered/math', conceptId: 'covered', dimension: 'math' },
    { cardId: 'covered/implementation', conceptId: 'covered', dimension: 'implementation' },
    { cardId: 'selected/math', conceptId: 'selected', dimension: 'math' },
    { cardId: 'selected/implementation', conceptId: 'selected', dimension: 'implementation' },
    { cardId: 'dropped/math', conceptId: 'dropped', dimension: 'math' },
  ];

  expect(
    p14UncoveredDueCards(
      dueCards,
      [
        {
          conceptIds: ['lesson'],
          cardIds: new Set(['covered/math']),
          selectedCardIds: new Set(),
          unfinished: true,
        },
        {
          conceptIds: ['selected'],
          cardIds: new Set(['selected/math']),
          selectedCardIds: new Set(['selected/math']),
          unfinished: false,
        },
      ],
      explanations,
    ),
  ).toEqual([]);
  expect(
    p14UncoveredDueCards(
      dueCards,
      [
        {
          conceptIds: ['lesson'],
          cardIds: new Set(['covered/math']),
          selectedCardIds: new Set(),
          unfinished: false,
        },
        {
          conceptIds: ['selected'],
          cardIds: new Set(['selected/math']),
          selectedCardIds: new Set(['selected/math']),
          unfinished: false,
        },
      ],
      explanations,
    ),
  ).toEqual(['covered/math']);
  expect(p14UncoveredDueCards(dueCards, [], explanations)).toEqual([
    'covered/math',
    'selected/math',
  ]);
});

test('review feasibility requires positive minutes and respects budget and overdue cap bypass', () => {
  expect(reviewFeasible(8, 8, 0, 2)).toBe(true);
  expect(reviewFeasible(8, 7, 0, 2)).toBe(false);
  expect(reviewFeasible(8, 8, 7, 0)).toBe(false);
  expect(reviewFeasible(0, 8, 8, 0)).toBe(false);
});

test('P6 flags only feasible reviews left overdue beyond a week', () => {
  expect(p6HasFeasibleOverdueReview(8, 8, 8, 0)).toBe(true);
  expect(p6HasFeasibleOverdueReview(8, 9, 8, 0)).toBe(false);
  expect(p6HasFeasibleOverdueReview(7, 8, 8, 0)).toBe(false);
});

test('P15 trace rejects duplicate source/card applications', () => {
  const now = new Date('2026-01-14T12:00:00.000Z');
  const parent = p15Card('parent-card', 'parent', '2026-04-14T12:00:00.000Z');
  const logs = [{ cardId: 'child-log', conceptId: 'child', rating: String(Rating.Good) }];
  const event = p15TraceEvent('child', Rating.Good, parent, 0.5, now);
  const once = { ...parent, dueAt: event.after.dueAt, fsrs: event.after.fsrs };
  const audit = (trace: (typeof event)[]) =>
    auditP15Trace([parent], [once], logs, trace, p15Weights, now, 'UTC', 'review');

  expect(audit([event]).violations).toEqual([]);
  expect(audit([event, event]).violations.join(' ')).toContain('duplicate source/card pair');
});

test('P15 trace requires each source rating to match its minimum dimension rating', () => {
  const now = new Date('2026-01-14T12:00:00.000Z');
  const parent = p15Card('parent-card', 'parent', '2026-04-14T12:00:00.000Z');
  const logs = [
    { cardId: 'child-hard-log', conceptId: 'child', rating: String(Rating.Hard) },
    { cardId: 'child-good-log', conceptId: 'child', rating: String(Rating.Good) },
  ];
  const wrong = p15TraceEvent('child', Rating.Good, parent, 0.5, now);
  const right = p15TraceEvent('child', Rating.Hard, parent, 0.5, now);
  const audit = (event: typeof wrong) =>
    auditP15Trace(
      [parent],
      [{ ...parent, dueAt: event.after.dueAt, fsrs: event.after.fsrs }],
      logs,
      [event],
      p15Weights,
      now,
      'UTC',
      'review',
    );

  expect(audit(right).violations).toEqual([]);
  expect(audit(wrong).violations.join(' ')).toContain('does not match activity minimum');
});

test('P15 trace checks Again weight in descendant-to-source orientation', () => {
  const now = new Date('2026-01-14T12:00:00.000Z');
  const descendant = p15Card('descendant-card', 'descendant', '2026-04-14T12:00:00.000Z');
  const logs = [{ cardId: 'prerequisite-log', conceptId: 'prerequisite', rating: '1' }];
  const right = p15TraceEvent('prerequisite', Rating.Again, descendant, 0.5, now);
  const wrong = p15TraceEvent('prerequisite', Rating.Again, descendant, 0.25, now);
  const audit = (event: typeof right) =>
    auditP15Trace(
      [descendant],
      [{ ...descendant, dueAt: event.after.dueAt, fsrs: event.after.fsrs }],
      logs,
      [event],
      p15Weights,
      now,
      'UTC',
      'review',
    );

  expect(audit(right).violations).toEqual([]);
  expect(audit(wrong).violations.join(' ')).toContain('trace weight');
});

test('P15 trace compares every result with pure implicitRepetition', () => {
  const now = new Date('2026-01-14T12:00:00.000Z');
  const parent = p15Card('parent-card', 'parent', '2026-01-14T12:00:00.000Z');
  const logs = [{ cardId: 'child-log', conceptId: 'child', rating: String(Rating.Good) }];
  const event = p15TraceEvent('child', Rating.Good, parent, 0.5, now);
  const once = { ...parent, dueAt: event.after.dueAt, fsrs: event.after.fsrs };
  const twice = applyExpectedImplicitCredit(once, Rating.Good, 0.5, now);
  const invalidEvent = {
    ...event,
    after: {
      dueAt: twice.dueAt,
      fsrs: twice.fsrs,
      stability: twice.fsrs.stability,
      difficulty: twice.fsrs.difficulty,
    },
  };
  const audit = (
    trace: typeof event,
    after: {
      id: string;
      conceptId: string;
      dueAt: Date;
      lastReviewAt: Date | null;
      fsrs: Card;
    },
  ) => auditP15Trace([parent], [after], logs, [trace], p15Weights, now, 'UTC', 'review');

  expect(audit(event, once).violations).toEqual([]);
  expect(audit(invalidEvent, twice).violations.join(' ')).toContain(
    'does not match implicitRepetition',
  );

  const alreadyLater = p15Card('already-later', 'parent', '2026-04-14T12:00:00.000Z');
  const noOpEvent = p15TraceEvent('child', Rating.Good, alreadyLater, 0.5, now);
  expect(noOpEvent.applied).toBe(false);
  expect(
    auditP15Trace(
      [alreadyLater],
      [alreadyLater],
      logs,
      [noOpEvent],
      p15Weights,
      now,
      'UTC',
      'review',
    ).violations,
  ).toEqual([]);
});

test('P15 coverage catches omitted explain-follow-up credit and accepts its trace', () => {
  const now = new Date('2026-01-14T12:00:00.000Z');
  const parent = p15Card('parent-card', 'parent', '2026-01-14T12:00:00.000Z');
  const logs = [
    { cardId: 'explain-follow-up-log', conceptId: 'child', rating: String(Rating.Hard) },
  ];
  const event = p15TraceEvent('child', Rating.Hard, parent, 0.5, now);
  const once = { ...parent, dueAt: event.after.dueAt, fsrs: event.after.fsrs };
  const audit = (trace: (typeof event)[]) =>
    auditP15Trace([parent], [once], logs, trace, p15Weights, now, 'UTC', 'learn');

  expect(audit([event]).violations).toEqual([]);
  expect(audit([]).violations.join(' ')).toContain('coverage missing');
});

test("P15 coverage does not expect implicit credit on the source concept's own card", () => {
  const now = new Date('2026-01-14T12:00:00.000Z');
  const sourceCard = p15Card('source-card', 'child', now.toISOString());
  const logs = [{ cardId: 'source-log', conceptId: 'child', rating: String(Rating.Good) }];

  expect(
    auditP15Trace([sourceCard], [sourceCard], logs, [], p15Weights, now, 'UTC', 'review')
      .violations,
  ).toEqual([]);
});

test('P15 preserves lesson rating semantics and the Again guard', () => {
  const now = new Date('2026-01-14T12:00:00.000Z');
  const parent = p15Card('parent-card', 'parent', '2026-04-14T12:00:00.000Z');
  const logs = [
    { cardId: 'child-hard-log', conceptId: 'child', rating: String(Rating.Hard) },
    { cardId: 'child-good-log', conceptId: 'child', rating: String(Rating.Good) },
  ];
  const event = p15TraceEvent('child', Rating.Hard, parent, 0.5, now);
  const once = { ...parent, dueAt: event.after.dueAt, fsrs: event.after.fsrs };

  expect(
    auditP15Trace([parent], [once], logs, [event], p15Weights, now, 'UTC', 'learn').violations,
  ).toEqual([]);
  expect(
    auditP15Trace(
      [parent],
      [parent],
      [{ ...logs[0], rating: String(Rating.Again) }],
      [],
      p15Weights,
      now,
      'UTC',
      'learn',
    ).violations,
  ).toEqual([]);
});

test('P15 exempts a prerequisite reset selected by the engine helper after a trace', () => {
  const now = new Date('2026-01-14T12:00:00.000Z');
  const parent = p15Card('parent-card', 'parent', '2026-04-14T12:00:00.000Z');
  const logs = [
    { cardId: 'child-log', conceptId: 'child', rating: String(Rating.Good) },
    {
      cardId: 'prerequisite-log',
      conceptId: 'prerequisite',
      rating: String(Rating.Again),
      previousLog: {
        rating: String(Rating.Again),
        createdAt: new Date('2026-01-07T12:00:00.000Z'),
      },
    },
  ];
  const event = p15TraceEvent('child', Rating.Good, parent, 0.5, now, 0);
  const reset = {
    ...parent,
    dueAt: now,
    fsrs: { ...event.after.fsrs, due: now },
  };
  const resetContext = {
    hardPrerequisiteIdsByConcept: new Map([['prerequisite', ['parent']]]),
    completedReviewConceptIds: new Set<string>(),
    coveredDimensionKeys: new Set<string>(),
  };

  const audit = auditP15Trace(
    [parent],
    [reset],
    logs,
    [event],
    p15Weights,
    now,
    'UTC',
    'review',
    new Map([
      ['child-log', 0],
      ['prerequisite-log', 1],
    ]),
    resetContext,
  );
  expect(audit.violations).toEqual([]);
  expect(audit.prerequisiteResetEvidence[0]?.selectedCardId).toBe('parent-card');
});

test('P16 flags a selected review when a dropped review is two days more overdue', () => {
  expect(p16HasOverduePrecedenceViolation(5, 3, 8, 4, 0, 4)).toBe(true);
  expect(p16HasOverduePrecedenceViolation(5, 3, 8, 3, 0, 4)).toBe(false);
  expect(p16HasOverduePrecedenceViolation(5, 3, 7, 0, 0, 4)).toBe(false);
  expect(p16HasOverduePrecedenceViolation(5, 3, 7, 0, 0, 6)).toBe(false);
  expect(p16HasOverduePrecedenceViolation(4, 3, 8, 4, 0, 4)).toBe(false);
});

test('P17 flags a dropped review only when it fits both remaining limits', () => {
  expect(p17ReviewFitsRemaining(8, 12, 8, 0)).toBe(true);
  expect(p17ReviewFitsRemaining(8, 12, 7, 0)).toBe(false);
  expect(p17ReviewFitsRemaining(8, 8, 0, 2)).toBe(true);
  expect(p17ReviewFitsRemaining(0, 0, 0, 0)).toBe(false);
  expect(requireP17ReviewMinutes('vectors', 8)).toBe(8);
  expect(() => requireP17ReviewMinutes('vectors', 0)).toThrow(/vectors/);
  expect(() => requireP17ReviewMinutes('vectors', undefined)).toThrow(/vectors/);
});

test('P18 flags a missed same-day low-credit pickup only while it remains due without a log', () => {
  expect(p18HasMissedPickup(true, false, false, 8, 12, 8, 0)).toBe(true);
  expect(p18HasMissedPickup(true, false, false, 8, 7, 8, 0)).toBe(false);
  expect(p18HasMissedPickup(false, false, false, 8, 12, 8, 0)).toBe(false);
  expect(p18HasMissedPickup(true, true, false, 8, 12, 8, 0)).toBe(false);
  expect(p18HasMissedPickup(true, false, true, 8, 12, 8, 0)).toBe(false);
});

test('P19 requires an early non-remediation review to cover two new due topics', () => {
  expect(p19HasEarlyReviewViolation(false, 1, false)).toBe(true);
  expect(p19HasEarlyReviewViolation(false, 2, false)).toBe(false);
  expect(p19HasEarlyReviewViolation(true, 0, false)).toBe(false);
  expect(p19HasEarlyReviewViolation(false, 0, true)).toBe(false);
});

test('P19 only audits reviews newly selected by the current plan', () => {
  expect(
    selectedReviewConceptsForAudit(
      ['selected', 'covered', 'excludedByReplan'],
      [
        { conceptId: 'selected', result: 'selected' },
        { conceptId: 'covered', result: 'covered' },
        { conceptId: 'excludedByReplan', result: 'not_candidate:excludedByReplan' },
      ],
    ),
  ).toEqual(['selected']);
});

test('a simulated API 5xx retains the originating request and response', () => {
  const failure = new SimulatedApiFailureError({
    method: 'POST',
    path: '/sessions',
    status: 503,
    requestBody: { budgetMinutes: 20 },
    responseBody: { error: 'unavailable' },
  });

  expect(failure.request).toMatchObject({
    method: 'POST',
    path: '/sessions',
    status: 503,
    requestBody: { budgetMinutes: 20 },
    responseBody: { error: 'unavailable' },
  });
  expect(failure.message).toContain('POST /sessions failed (503)');
  expect(failure.message).toContain('request={"budgetMinutes":20}');
});

test('two profiles produce byte-identical 15-day simulation reports from the same seed', async () => {
  const content = await loadContent();
  const options = {
    profiles: ['average', 'struggling'] as SimulationProfile[],
    days: 15,
    courseIds: ['maths-for-ml'],
  };
  const first = await simulateLearners(db, content, options);
  const second = await simulateLearners(db, content, options);

  expect(JSON.stringify(stripWallClockFields(second))).toBe(
    JSON.stringify(stripWallClockFields(first)),
  );
}, 120_000);

test('same-timestamp review logs exclude logs created by the lesson quiz', () => {
  const timestamp = new Date('2026-01-14T12:00:00.000Z');
  const quizLog = {
    id: 'quiz-log',
    cardId: 'lesson-card',
    conceptId: 'lesson-concept',
    rating: '3',
    createdAt: timestamp,
  };
  const reviewLog = {
    id: 'review-log',
    cardId: 'review-card',
    conceptId: 'review-concept',
    rating: '2',
    createdAt: timestamp,
  };
  const checkedIds = new Set<string>();

  expect(attributeActivityLogs(new Set(), [quizLog], checkedIds)).toEqual([quizLog]);
  expect(checkedIds).toEqual(new Set(['quiz-log']));
  expect(attributeActivityLogs(new Set([quizLog.id]), [quizLog, reviewLog], checkedIds)).toEqual([
    reviewLog,
  ]);
  expect(checkedIds).toEqual(new Set(['quiz-log', 'review-log']));
});

test('diligent and graph-change Mathematics for ML runs produce structured reports', async () => {
  const content = await loadContent();
  const report = await simulateLearners(db, content, {
    profiles: ['diligent', 'graph-change'],
    days: 45,
    courseIds: ['maths-for-ml'],
  });

  expect(report).toMatchObject({
    dayCap: 45,
    profiles: [
      { profile: 'diligent', courses: [expect.objectContaining({ courseId: 'maths-for-ml' })] },
      {
        profile: 'graph-change',
        courses: [expect.objectContaining({ courseId: 'maths-for-ml' })],
      },
    ],
  });
  const diligent = report.profiles.find((profile) => profile.profile === 'diligent');
  const first30Days = diligent?.dailyStats.filter((stats) => stats.day <= 30) ?? [];
  expect(first30Days.some((stats) => stats.reviews > 0)).toBe(true);
  expect(
    first30Days.reduce((total, stats) => total + stats.newTopicsCompleted, 0),
  ).toBeGreaterThanOrEqual(10);
  expect(renderMarkdownReport(report)).toContain('P11 ambiguous');
  const struggling = await simulateLearners(db, content, {
    profiles: ['struggling'],
    days: 12,
    courseIds: ['maths-for-ml'],
  });
  expect(struggling.profiles[0]?.dailyStats.some((stats) => stats.reviews > 0)).toBe(true);
  for (const profile of report.profiles) {
    expect(profile.daysSimulated).toBeLessThanOrEqual(45);
    expect(profile.dailyStats).toEqual(expect.any(Array));
    expect(profile.violations).toEqual(expect.any(Array));
    expect(profile.projectsOffered).toEqual(expect.any(Array));
    expect(profile.papersRecorded).toEqual(expect.any(Array));
    expect(profile.totals.wrongPercent).toEqual(expect.any(Number));
    expect(profile.totals.explicitReviews).toEqual(expect.any(Number));
    expect(profile.totals.positiveImplicitCredits).toEqual(expect.any(Number));
    expect(profile.totals.negativeImplicitCredits).toEqual(expect.any(Number));
    expect(profile.totals.coveredSkips).toEqual(expect.any(Number));
    expect(profile.p11CheckedEvents).toEqual(expect.any(Number));
    expect(profile.p11AmbiguousEvents).toEqual(expect.any(Number));
    for (const invariant of ['P13', 'P14', 'P15', 'P16', 'P17', 'P18', 'P19'] as const) {
      expect(profile.checkedCounts[invariant]).toEqual(expect.any(Number));
    }
    for (const invariant of invariants) {
      expect(profile.violationCounts[invariant]).toEqual(expect.any(Number));
    }
  }
}, 110_000);

test('gap learner reviews logistic regression before completing the affected lesson', async () => {
  const report = await simulateLearners(db, await loadContent(), {
    profiles: ['gap'],
    days: 45,
    courseIds: ['maths-for-ml', 'ml-foundations'],
  });
  const gap = report.profiles[0];
  expect(gap?.violationCounts.P12).toBe(0);
  expect(gap?.remediation.totals.noProgressHalts).toBeGreaterThanOrEqual(1);
  expect(
    gap?.remediation.flagsOpened.some((event) => event.prerequisiteId === 'logistic-regression'),
  ).toBe(true);
  const affectedLesson = gap?.remediation.gapTimeline?.find(
    (timeline) =>
      timeline.flagsOpened.some((event) => event.prerequisiteId === 'logistic-regression') &&
      timeline.completionDays.length > 0,
  );
  expect(affectedLesson).toBeDefined();
  const reviewedDay = affectedLesson?.prereqsReviewed.find(
    (event) => event.prerequisiteId === 'logistic-regression',
  )?.day;
  expect(reviewedDay).toBeDefined();
  expect(reviewedDay).toBeLessThanOrEqual(affectedLesson?.completionDays[0] ?? 0);
}, 150_000);
