import { afterAll, expect, test } from 'vitest';
import { type InvariantId, simulateLearners } from '../../scripts/learner-simulator.js';
import { env } from '../../src/config.js';
import { loadContent } from '../../src/content/load.js';
import { createDb } from '../../src/db/client.js';

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
];

afterAll(async () => {
  await db.$client.end();
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
  expect(reviewedDay).toBeLessThan(affectedLesson?.completionDays[0] ?? 0);
}, 150_000);
