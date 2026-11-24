import { type Card, Rating, State } from 'ts-fsrs';
import { afterAll, expect, test } from 'vitest';
import {
  attributeActivityLogs,
  auditP11DescendantCard,
  auditP15ImplicitCredits,
  type InvariantId,
  p13HasEmptyPlanViolation,
  p14UncoveredDueCards,
  p16HasOverduePrecedenceViolation,
  p17ReviewFitsRemaining,
  p18HasMissedPickup,
  p19HasEarlyReviewViolation,
  renderMarkdownReport,
  SimulatedApiFailureError,
  type SimulationProfile,
  simulateLearners,
} from '../../scripts/learner-simulator.js';
import { env } from '../../src/config.js';
import { loadContent } from '../../src/content/load.js';
import { createDb } from '../../src/db/client.js';
import { newReviewCard, scheduleReview } from '../../src/learning/fsrs.js';
import { implicitRepetition } from '../../src/learning/implicit-repetition.js';

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
  weight: (sourceConceptId: string, targetConceptId: string) =>
    (sourceConceptId === 'child' && targetConceptId === 'parent') ||
    (sourceConceptId === 'prerequisite' && targetConceptId === 'descendant')
      ? 0.5
      : 0,
  ancestors: (conceptId: string) => new Map(conceptId === 'child' ? [['parent', 0.5]] : []),
  descendants: (conceptId: string) =>
    new Map(conceptId === 'prerequisite' ? [['descendant', 0.5]] : []),
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

test('P14 reports uncovered due cards and passes when saved activity coverage includes them', () => {
  expect(p14UncoveredDueCards(['card-a', 'card-b'], [new Set(['card-a'])])).toEqual(['card-b']);
  expect(
    p14UncoveredDueCards(['card-a', 'card-b'], [new Set(['card-a']), new Set(['card-b'])]),
  ).toEqual([]);
});

test('P15 flags missing Again credit and accepts one update', () => {
  const now = new Date('2026-01-14T12:00:00.000Z');
  const prerequisite = p15Card('descendant-card', 'descendant', '2026-04-14T12:00:00.000Z');
  const logs = [{ cardId: 'prerequisite-log', conceptId: 'prerequisite', rating: '1' }];
  const once = applyExpectedImplicitCredit(prerequisite, Rating.Again, 0.5, now);

  expect(
    auditP15ImplicitCredits(
      [prerequisite],
      [prerequisite],
      logs,
      ['prerequisite'],
      p15Weights,
      now,
      'UTC',
    ).violations,
  ).not.toEqual([]);
  expect(
    auditP15ImplicitCredits([prerequisite], [once], logs, ['prerequisite'], p15Weights, now, 'UTC')
      .violations,
  ).toEqual([]);
});

test('P15 flags duplicate credit and requires positive credit to update an ancestor', () => {
  const now = new Date('2026-01-14T12:00:00.000Z');
  const parent = p15Card('parent-card', 'parent', '2026-01-14T12:00:00.000Z');
  const logs = [{ cardId: 'child-log', conceptId: 'child', rating: String(Rating.Good) }];
  const once = applyExpectedImplicitCredit(parent, Rating.Good, 0.5, now);
  const twice = applyExpectedImplicitCredit(once, Rating.Good, 0.5, now);

  expect(
    auditP15ImplicitCredits([parent], [once], logs, ['child'], p15Weights, now, 'UTC').violations,
  ).toEqual([]);
  expect(
    auditP15ImplicitCredits([parent], [twice], logs, ['child'], p15Weights, now, 'UTC').violations,
  ).not.toEqual([]);
});

test('P16 flags a selected review when a dropped review is two days more overdue', () => {
  expect(p16HasOverduePrecedenceViolation(5, 3)).toBe(true);
  expect(p16HasOverduePrecedenceViolation(4, 3)).toBe(false);
});

test('P17 flags a dropped review only when it fits both remaining limits', () => {
  expect(p17ReviewFitsRemaining(8, 12, 8)).toBe(true);
  expect(p17ReviewFitsRemaining(8, 12, 7)).toBe(false);
});

test('P18 flags a missed same-day low-credit pickup only while it remains due without a log', () => {
  expect(p18HasMissedPickup(true, false, false)).toBe(true);
  expect(p18HasMissedPickup(false, false, false)).toBe(false);
  expect(p18HasMissedPickup(true, true, false)).toBe(false);
  expect(p18HasMissedPickup(true, false, true)).toBe(false);
});

test('P19 requires an early non-remediation review to cover two new due topics', () => {
  expect(p19HasEarlyReviewViolation(false, 1, false)).toBe(true);
  expect(p19HasEarlyReviewViolation(false, 2, false)).toBe(false);
  expect(p19HasEarlyReviewViolation(true, 0, false)).toBe(false);
  expect(p19HasEarlyReviewViolation(false, 0, true)).toBe(false);
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
