import { expect, test } from '@playwright/test';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import { courseEnrollments, users } from '../../apps/api/src/db/schema.js';

const db = createDb(env.TEST_DATABASE_URL);

test.beforeEach(async () => {
  await db.delete(users);
  const [user] = await db
    .insert(users)
    .values({
      displayName: 'Up next E2E learner',
      timezone: 'UTC',
      studySetInitializedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error('Expected up next learner');
  await db.insert(courseEnrollments).values(
    ['fixture-course', 'fixture-switching-course'].map((courseId) => ({
      userId: user.id,
      courseId,
      status: 'active' as const,
      startMethod: 'beginning' as const,
    })),
  );
});

test.afterAll(async () => {
  await db.$client.end();
});

test('Up next lists projected topics by week and keeps Finished collapsed', async ({ page }) => {
  await page.route('**/api/learn', (route) =>
    route.fulfill({
      json: {
        upNext: {
          upcoming: [
            {
              conceptId: 'topic-one',
              courseId: 'fixture-course',
              courseTitle: 'Fixture course',
              title: 'Topic One',
              unitTitle: 'First unit',
              date: '2026-01-07',
              dayLabel: 'Today',
            },
            {
              conceptId: 'topic-two',
              courseId: 'fixture-switching-course',
              courseTitle: 'Fixture switching course',
              title: 'Topic Two',
              unitTitle: 'Second unit',
              date: '2026-01-12',
              dayLabel: 'Monday',
            },
          ],
          allSubjects: null,
          finished: [
            {
              conceptId: 'topic-done',
              courseId: 'fixture-course',
              courseTitle: 'Fixture course',
              title: 'Finished Topic',
              unitTitle: 'First unit',
              date: '2026-01-07',
            },
            {
              conceptId: 'topic-undated',
              courseId: 'fixture-course',
              courseTitle: 'Fixture course',
              title: 'Undated Topic',
              unitTitle: 'First unit',
            },
          ],
        },
      },
    }),
  );
  await page.goto('/map');

  await expect(page.getByRole('heading', { name: 'Up next', exact: true })).toBeAttached();
  await expect(page.getByRole('heading', { name: 'Week of Jan 5', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Week of Jan 12', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /Topic One/ })).toContainText('Today');
  await expect(page.getByRole('link', { name: /Topic Two/ })).toContainText('Monday');
  await expect(page.getByRole('link', { name: /Topic Two/ })).toContainText(
    'Fixture switching course · Second unit',
  );
  const topicCard = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole('link', { name: /Topic One/ }) });
  await expect(topicCard).toHaveCSS('background-color', 'rgb(254, 253, 251)');
  const finished = page.getByRole('button', { name: 'Finished (2)', exact: true });
  await expect(finished).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('Finished Topic', { exact: true })).not.toBeVisible();
  await finished.click();
  await expect(finished).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Finished Topic', { exact: true })).toBeVisible();
  const finishedCard = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText('Finished Topic', { exact: true }) });
  await expect(finishedCard).toHaveCSS('background-color', 'rgb(254, 253, 251)');
  const undatedRow = page.getByText('Undated Topic', { exact: true }).locator('xpath=../..');
  await expect(undatedRow).toBeVisible();
  await expect(undatedRow).not.toContainText('2026');
});

test('Up next explains when no topics are projected', async ({ page }) => {
  await page.route('**/api/learn', (route) =>
    route.fulfill({ json: { upNext: { upcoming: [], allSubjects: null, finished: [] } } }),
  );
  await page.goto('/map');
  await expect(
    page.getByText(
      'No topics are currently projected. Add an active course or complete a prerequisite to see what is next.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Finished (0)', exact: true })).toBeVisible();
});

test('Show all subjects toggles between the focused and full projections', async ({ page }) => {
  const aiTopic = {
    conceptId: 'ai-topic',
    courseId: 'fixture-switching-course',
    courseTitle: 'Fixture switching course',
    title: 'AI Topic',
    unitTitle: 'AI unit',
    date: '2026-01-12',
    dayLabel: 'Monday',
  };
  const mathTopic = {
    conceptId: 'math-topic',
    courseId: 'fixture-course',
    courseTitle: 'Fixture course',
    title: 'Mathematics Topic',
    unitTitle: 'Math unit',
    date: '2026-01-12',
    dayLabel: 'Monday',
  };
  await page.route('**/api/learn', (route) =>
    route.fulfill({
      json: {
        activeSubjects: [
          { id: 'ai', title: 'AI', hasLessons: true },
          { id: 'mathematics', title: 'Mathematics', hasLessons: true },
        ],
        focusSubjectId: 'ai',
        upNext: { upcoming: [aiTopic], allSubjects: [aiTopic, mathTopic], finished: [] },
      },
    }),
  );
  await page.goto('/map');

  const toggle = page.getByRole('button', { name: 'Show all subjects', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('link', { name: /AI Topic/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Mathematics Topic/ })).toHaveCount(0);
  await toggle.click();
  const focusedToggle = page.getByRole('button', { name: 'Show AI only', exact: true });
  await expect(focusedToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('link', { name: /Mathematics Topic/ })).toBeVisible();
  await focusedToggle.click();
  await expect(
    page.getByRole('button', { name: 'Show all subjects', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('link', { name: /Mathematics Topic/ })).toHaveCount(0);
});

test('Up next renders every projected topic returned by the API', async ({ page }) => {
  const topics = Array.from({ length: 25 }, (_, index) => ({
    conceptId: `projected-${index + 1}`,
    courseId: 'fixture-course',
    courseTitle: 'Fixture course',
    title: `Projected topic ${index + 1}`,
    unitTitle: 'Projected unit',
    date: '2026-01-12',
    dayLabel: 'Monday',
  }));
  await page.route('**/api/learn', (route) =>
    route.fulfill({
      json: {
        activeSubjects: [],
        focusSubjectId: null,
        upNext: { upcoming: topics, allSubjects: null, finished: [] },
      },
    }),
  );
  await page.goto('/map');

  await expect(page.getByRole('link', { name: /Projected topic/ })).toHaveCount(25);
});
