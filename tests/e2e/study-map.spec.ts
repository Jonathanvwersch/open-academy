import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import { courseEnrollments, users } from '../../apps/api/src/db/schema.js';

const db = createDb(env.TEST_DATABASE_URL);
const screenshots = '/home/ubuntu/study-map-screenshots';

test.beforeEach(async () => {
  mkdirSync(screenshots, { recursive: true });
  await db.delete(users);
  const [user] = await db
    .insert(users)
    .values({ displayName: 'Map E2E learner', timezone: 'UTC', studySetInitializedAt: new Date() })
    .returning();
  if (!user) throw new Error('Expected map learner');
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

test('study map groups shared topics once and opens available lessons', async ({ page }) => {
  const payloadResponse = page.waitForResponse('**/api/study-map');
  await page.goto('/map');
  const payload: { nodes: Array<{ id: string; groupId: string }> } = await (
    await payloadResponse
  ).json();
  const graph = page.getByRole('region', { name: 'Study map graph', exact: true });
  await expect(graph.getByText('Fixture course', { exact: true })).toBeVisible();
  await expect(graph.getByText('Fixture switching course', { exact: true })).toBeVisible();
  await expect(
    graph.getByRole('button', { name: 'Linear models: Locked', exact: true }),
  ).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Fixture course', exact: true })).toBeVisible();
  const geometryErrors = await graph.locator('.react-flow__node').evaluateAll(
    (elements, parents) => {
      const groups = new Map(
        elements
          .filter((element) => element.classList.contains('react-flow__node-courseGroup'))
          .map((element) => [element.getAttribute('data-id'), element.getBoundingClientRect()]),
      );
      const topics = elements
        .filter((element) => element.classList.contains('react-flow__node-topic'))
        .map((element) => ({
          id: element.getAttribute('data-id'),
          group: parents[element.getAttribute('data-id') ?? ''] ?? null,
          box: element.getBoundingClientRect(),
        }));
      const errors: string[] = [];
      for (const [index, topic] of topics.entries()) {
        const parent = groups.get(topic.group);
        const a = topic.box;
        if (
          !parent ||
          a.left < parent.left ||
          a.top < parent.top ||
          a.right > parent.right ||
          a.bottom > parent.bottom
        )
          errors.push(`${topic.id} is outside its group`);
        for (const other of topics.slice(index + 1)) {
          const b = other.box;
          if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)
            errors.push(`${topic.id} overlaps ${other.id}`);
        }
      }
      return errors;
    },
    Object.fromEntries(payload.nodes.map((node) => [node.id, `group:${node.groupId}`])),
  );
  expect(geometryErrors).toEqual([]);
  const locked = graph.getByRole('button', { name: 'Derivatives: Locked', exact: true });
  await locked.click();
  await expect(page.getByRole('dialog')).toContainText('Needs:');
  await expect(page.getByRole('dialog')).toContainText('Vectors');
  await page.screenshot({ path: `${screenshots}/desktop-needs.png`, fullPage: true });
  await page.keyboard.press('Escape');
  await graph.getByRole('link', { name: 'Vectors: Not started', exact: true }).click();
  await expect(page).toHaveURL(/\/lessons\/vectors$/);
});

test('map supports keyboard activation and a mobile topic list', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/map');
  await expect(page.getByRole('region', { name: 'Study map graph' })).toBeVisible();
  const viewport = page.locator('.react-flow__viewport');
  const initialTransform = await viewport.getAttribute('style');
  await page.getByRole('button', { name: 'Zoom In', exact: true }).click();
  await expect(viewport).not.toHaveAttribute('style', initialTransform ?? '');
  await page.getByRole('button', { name: 'Fit View', exact: true }).click();
  const heading = page.getByRole('heading', { name: 'Fixture course', exact: true });
  await heading.scrollIntoViewIfNeeded();
  const locked = page.getByRole('button', { name: 'Derivatives: Locked', exact: true }).last();
  await locked.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('dialog')).toContainText('Vectors');
  await page.screenshot({ path: `${screenshots}/mobile-needs.png`, fullPage: true });
  await page.keyboard.press('Escape');
  const lesson = page.getByRole('link', { name: 'Vectors: Not started', exact: true }).last();
  await lesson.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/lessons\/vectors$/);
});

test.describe('touch navigation', () => {
  test.use({ hasTouch: true });

  test('mobile opens legibly, pans by touch and lets vertical swipes reach the list', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const cdp = await page.context().newCDPSession(page);
    await page.goto('/map');
    const topic = page.locator('.react-flow__node-topic').first();
    await expect(topic).toBeVisible();
    await expect
      .poll(async () => (await topic.boundingBox())?.width ?? 0)
      .toBeGreaterThanOrEqual(165);
    const graph = await page.getByRole('region', { name: 'Study map graph' }).boundingBox();
    if (!graph) throw new Error('Expected graph bounds');
    const viewport = page.locator('.react-flow__viewport');
    await expect(viewport).toHaveAttribute('style', /scale\(0.75\)/);
    const before = await viewport.getAttribute('style');
    const start = { x: graph.x + graph.width - 20, y: graph.y + graph.height - 140 };
    const swipe = async (dx: number, dy: number) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
      for (let step = 1; step <= 12; step++)
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: start.x + (dx * step) / 12, y: start.y + (dy * step) / 12 }],
        });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await swipe(-140, 0);
    await expect(viewport).not.toHaveAttribute('style', before ?? '');
    await swipe(0, -300);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
    await expect(
      page.getByRole('heading', { name: 'Fixture course', exact: true }),
    ).toBeInViewport();
  });
});

test('map loading, long titles and errors use the shared route surfaces', async ({ page }) => {
  let release: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/study-map', async (route) => {
    await ready;
    await route.fulfill({
      json: {
        groups: [
          {
            id: 'long-course',
            title:
              'A course with a much longer title about mathematical foundations and machine learning',
            kind: 'course',
          },
        ],
        nodes: [
          {
            id: 'long-topic',
            groupId: 'long-course',
            title: 'Understanding mathematical foundations with a longer topic title',
            status: 'not_started',
            placedOut: false,
            lessonAvailable: false,
            missingPrereqTitles: [],
          },
        ],
        edges: [],
      },
    });
  });
  await page.goto('/map');
  await expect(page.getByRole('status', { name: 'Loading page', exact: true })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/loading.png`, fullPage: true });
  release();
  await expect(page.getByRole('region', { name: 'Study map graph' })).toBeVisible();
  await page.screenshot({ path: `${screenshots}/long-titles.png`, fullPage: true });
  await page.unroute('**/api/study-map');
  await page.route('**/api/study-map', (route) =>
    route.fulfill({ status: 500, json: { error: 'Unavailable' } }),
  );
  await page.reload();
  await expect(page.getByText('The study map is unavailable.')).toBeVisible();
  await page.screenshot({ path: `${screenshots}/error.png`, fullPage: true });
});

test('empty study map links to the course catalogue', async ({ page }) => {
  await db.delete(courseEnrollments);
  await page.goto('/map');
  await expect(page.getByText('Add a course to see your map.')).toBeVisible();
  await page.getByRole('link', { name: 'Browse courses', exact: true }).click();
  await expect(page).toHaveURL(/\/courses$/);
  await expect(page.getByRole('link', { name: 'View map', exact: true })).toBeVisible();
});
