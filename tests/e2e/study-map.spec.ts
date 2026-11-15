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
          finished: [
            {
              conceptId: 'topic-done',
              courseId: 'fixture-course',
              courseTitle: 'Fixture course',
              title: 'Finished Topic',
              unitTitle: 'First unit',
              date: '2026-01-07',
            },
          ],
        },
      },
    }),
  );
  await page.goto('/map');

  await expect(page.getByRole('heading', { name: 'Up next', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Week of Jan 5', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Week of Jan 12', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /Topic One/ })).toContainText('Today');
  await expect(page.getByRole('link', { name: /Topic Two/ })).toContainText('Monday');
  await expect(page.getByRole('link', { name: /Topic Two/ })).toContainText(
    'Fixture switching course · Second unit',
  );
  const finished = page.getByRole('button', { name: 'Finished (1)', exact: true });
  await expect(finished).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('Finished Topic', { exact: true })).not.toBeVisible();
  await finished.click();
  await expect(page.getByText('Finished Topic', { exact: true })).toBeVisible();
});

test('Up next explains when no topics are projected', async ({ page }) => {
  await page.route('**/api/learn', (route) =>
    route.fulfill({ json: { upNext: { upcoming: [], finished: [] } } }),
  );
  await page.goto('/map');
  await expect(
    page.getByText(
      'No topics are currently projected. Add an active course or complete a prerequisite to see what is next.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Finished (0)', exact: true })).toBeVisible();
});
