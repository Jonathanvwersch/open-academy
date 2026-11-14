import { expect, test } from '@playwright/test';
import { env } from '../../apps/api/src/config.js';
import { createDb } from '../../apps/api/src/db/client.js';
import { courseEnrollments, users } from '../../apps/api/src/db/schema.js';

const db = createDb(env.TEST_DATABASE_URL);

test.beforeEach(async () => {
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
  const payload: {
    groups: Array<{ title: string }>;
    nodes: Array<{ id: string; groupId: string }>;
  } = await (await payloadResponse).json();
  const graph = page.getByRole('region', { name: 'Study map graph', exact: true });
  await expect(graph.getByText('Fixture course', { exact: true })).toBeVisible();
  await expect(graph.getByText('Fixture switching course', { exact: true })).toBeVisible();
  await expect(
    graph.getByRole('button', { name: 'Linear models: Locked', exact: true }),
  ).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Fixture course', exact: true })).toBeVisible();
  const frames = graph.locator('.react-flow__node-courseGroup');
  await expect(frames).toHaveCount(2);
  await expect(
    page.getByRole('navigation', { name: 'Jump to group' }).getByRole('button'),
  ).toHaveText(payload.groups.map((group) => group.title));
  await expect(graph.locator('[data-map-title]')).toHaveCount(2);
  for (const title of await graph.locator('[data-map-title]').all())
    await expect(title).toBeInViewport();
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style', /scale\(0.9\)/);
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
  const vectors = graph.getByRole('link', { name: 'Vectors: Not started', exact: true });
  await vectors.hover();
  await expect.poll(() => graph.locator('.map-edge-highlighted').count()).toBeGreaterThan(0);
  await expect(graph.locator('.react-flow__node-topic').last()).toHaveCSS('opacity', '0.2');
  await page.mouse.move(0, 0);
  await expect(graph.locator('.map-edge-highlighted')).toHaveCount(0);
  await vectors.focus();
  await expect.poll(() => graph.locator('.map-edge-highlighted').count()).toBeGreaterThan(0);
  const locked = graph.getByRole('button', { name: 'Derivatives: Locked', exact: true });
  await locked.click();
  await expect(page.getByRole('dialog')).toContainText('Needs:');
  await expect(page.getByRole('dialog')).toContainText('Vectors');
  await page.keyboard.press('Escape');
  await graph.getByRole('link', { name: 'Vectors: Not started', exact: true }).click();
  await expect(page).toHaveURL(/\/lessons\/vectors$/);
});

test('desktop canvas is full-width with filters above it and the page scrolls past it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/study-map', (route) =>
    route.fulfill({
      json: {
        groups: [{ id: 'wide', title: 'Fixture course', kind: 'course', sharedTopicGroupIds: [] }],
        nodes: Array.from({ length: 6 }, (_, index) => ({
          id: `topic-${index}`,
          groupId: 'wide',
          title: `Topic ${index}`,
          status: 'not_started',
          placedOut: false,
          lessonAvailable: false,
          missingPrereqTitles: [],
        })),
        edges: Array.from({ length: 5 }, (_, index) => ({
          from: `topic-${index}`,
          to: `topic-${index + 1}`,
        })),
      },
    }),
  );
  await page.goto('/map');
  const viewport = page.locator('.react-flow__viewport');
  await expect(viewport).toHaveAttribute('style', /scale\(0.9\)/);
  const graph = await page.getByRole('region', { name: 'Study map graph' }).boundingBox();
  const main = await page.getByRole('main').boundingBox();
  const legend = await page.getByRole('group', { name: 'Filter by status' }).boundingBox();
  if (!graph || !main || !legend) throw new Error('Expected canvas, main and legend bounds');
  expect(graph.width).toBeCloseTo(main.width, 0);
  expect(graph.x).toBeCloseTo(main.x, 0);
  expect(graph.height).toBeGreaterThanOrEqual(560);
  expect(legend.x).toBeGreaterThan(graph.x);
  expect(legend.y).toBeLessThan(graph.y);
  expect(legend.x + legend.width).toBeLessThan(graph.x + graph.width);
  expect(legend.y + legend.height).toBeLessThanOrEqual(graph.y);
  const legendContent = page.getByRole('group', { name: 'Filter by status' });
  await expect(legendContent.getByRole('button')).toHaveCount(4);
  expect(
    await legendContent
      .getByRole('button')
      .evaluateAll((items) => new Set(items.map((item) => item.getBoundingClientRect().top)).size),
  ).toBe(1);
  expect(
    await legendContent.evaluate((element) => {
      const key = element.getBoundingClientRect();
      const canvas = document.querySelector('.react-flow')?.getBoundingClientRect();
      if (!canvas) throw new Error('Expected canvas bounds');
      return [...document.querySelectorAll('.react-flow__node-topic, [data-map-title]')]
        .filter((node) => {
          const r = node.getBoundingClientRect();
          return (
            r.left < canvas.right &&
            r.right > canvas.left &&
            r.top < canvas.bottom &&
            r.bottom > canvas.top
          );
        })
        .filter((node) => {
          const r = node.getBoundingClientRect();
          return (
            key.left < r.right && key.right > r.left && key.top < r.bottom && key.bottom > r.top
          );
        })
        .map((node) => node.textContent);
    }),
  ).toEqual([]);
  await page.getByRole('navigation', { name: 'Jump to group' }).hover();
  await page.mouse.wheel(0, 900);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect(page.getByRole('heading', { name: 'Fixture course', exact: true })).toBeInViewport();
});

test('mobile shows all four status filters without opening a key', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/map');
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style', /scale\(0.8\)/);
  const legend = page.getByRole('group', { name: 'Filter by status' });
  await expect(legend.getByRole('button')).toHaveText([
    'Complete',
    'In progress',
    'Not started',
    'Locked',
  ]);
  for (const chip of await legend.getByRole('button').all())
    await expect(chip).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: 'Key', exact: true })).toHaveCount(0);
  const nav = await page.getByRole('navigation', { name: 'Jump to group' }).boundingBox();
  expect(nav?.width).toBeGreaterThan(300);
});

test('dependency order is shared by frames, Jump to and lists, and large jumps stay readable', async ({
  page,
}) => {
  const payload = {
    groups: [
      { id: 'foundations', title: 'Foundations', kind: 'foundations', sharedTopicGroupIds: [] },
      { id: 'ml', title: 'Machine Learning Foundations', kind: 'course', sharedTopicGroupIds: [] },
      { id: 'llm', title: 'LLM Inference', kind: 'course', sharedTopicGroupIds: [] },
    ],
    nodes: [
      { id: 'foundation', groupId: 'foundations' },
      ...Array.from({ length: 10 }, (_, i) => ({ id: `ml-${i}`, groupId: 'ml' })),
      ...Array.from({ length: 6 }, (_, i) => ({ id: `inference-${i}`, groupId: 'llm' })),
    ].map((node) => ({
      ...node,
      title: node.id,
      status: 'not_started',
      placedOut: false,
      lessonAvailable: false,
      missingPrereqTitles: [],
    })),
    edges: [
      { from: 'ml-0', to: 'foundation' },
      { from: 'foundation', to: 'inference-0' },
      ...Array.from({ length: 5 }, (_, i) => ({
        from: `inference-${i}`,
        to: `inference-${i + 1}`,
      })),
    ],
  };
  await page.route('**/api/study-map', (route) => route.fulfill({ json: payload }));
  await page.goto('/map');
  const nav = page.getByRole('navigation', { name: 'Jump to group' });
  const order = ['Machine Learning Foundations', 'Foundations', 'LLM Inference'];
  await expect(nav.getByRole('button')).toHaveText(order);
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(order);
  await expect(page.locator('[data-map-title]')).toHaveText(order);
  const title = page.locator('[data-id="title:llm"] [data-map-title]');
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style', /scale\(0.9\)/);
  await expect(title).not.toBeInViewport();
  const centered = async (id: string) => {
    await expect
      .poll(() =>
        page.locator(`[data-id="group:${id}"]`).evaluate((element) => {
          const frame = element.getBoundingClientRect();
          const canvas = element.closest('.react-flow')?.getBoundingClientRect();
          if (!canvas) throw new Error('Expected canvas');
          return (
            Math.abs(frame.x + frame.width / 2 - canvas.x - canvas.width / 2) +
            Math.abs(frame.y + frame.height / 2 - canvas.y - canvas.height / 2)
          );
        }),
      )
      .toBeLessThan(2);
    const zoom = await page
      .locator('.react-flow__viewport')
      .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a);
    expect(zoom).toBeLessThanOrEqual(1);
    expect(zoom).toBeGreaterThanOrEqual(0.8);
  };
  const anchored = async () => {
    await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style', /scale\(0.8\)/);
    const inset = await page.locator('[data-id="group:llm"]').evaluate((element) => {
      const frame = element.getBoundingClientRect();
      const canvas = element.closest('.react-flow')?.getBoundingClientRect();
      if (!canvas) throw new Error('Expected canvas');
      return { x: frame.x - canvas.x, y: frame.y - canvas.y };
    });
    expect(inset.x).toBeCloseTo(24, 0);
    expect(inset.y).toBeCloseTo(24, 0);
    await expect(title).toBeInViewport();
  };
  const llm = nav.getByRole('button', { name: 'LLM Inference', exact: true });
  await llm.click();
  await anchored();
  await nav.getByRole('button', { name: 'Foundations', exact: true }).click();
  await centered('foundations');
  await llm.focus();
  await page.keyboard.press('Enter');
  await anchored();
  await page.getByRole('button', { name: 'Fit View', exact: true }).click();
  await expect
    .poll(() =>
      page.locator('.react-flow__node-courseGroup').evaluateAll((elements) => {
        const canvas = elements[0]?.closest('.react-flow')?.getBoundingClientRect();
        return (
          !!canvas &&
          elements.every((element) => {
            const r = element.getBoundingClientRect();
            return (
              r.left >= canvas.left &&
              r.right <= canvas.right &&
              r.top >= canvas.top &&
              r.bottom <= canvas.bottom
            );
          })
        );
      }),
    )
    .toBe(true);
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
  await page.keyboard.press('Escape');
  await expect(locked).toBeFocused();
  const lesson = page.getByRole('link', { name: 'Vectors: Not started', exact: true }).last();
  await lesson.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/lessons\/vectors$/);
});

test.describe('touch navigation', () => {
  test.use({ hasTouch: true });

  test('mobile opens at readable zoom, pans by touch and lets vertical swipes reach the list', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const cdp = await page.context().newCDPSession(page);
    await page.goto('/map');
    const topic = page.locator('.react-flow__node-topic').first();
    await expect(topic).toBeVisible();
    const graph = await page.getByRole('region', { name: 'Study map graph' }).boundingBox();
    const canvas = await page.locator('.react-flow').boundingBox();
    if (!graph || !canvas) throw new Error('Expected graph bounds');
    const viewport = page.locator('.react-flow__viewport');
    const firstGroup = page.locator('.react-flow__node-courseGroup').first();
    await expect(viewport).toHaveAttribute('style', /scale\(0.8\)/);
    expect((await topic.boundingBox())?.width).toBeCloseTo(176, 0);
    expect((await firstGroup.boundingBox())?.x).toBeCloseTo(canvas.x + 24, 0);
    expect((await firstGroup.boundingBox())?.y).toBeCloseTo(canvas.y + 24, 0);
    expect(graph.height).toBeGreaterThanOrEqual(560);
    await expect(page.locator('[data-map-title]').first()).toBeInViewport();
    const before = await viewport.getAttribute('style');
    const start = { x: graph.x + graph.width - 12, y: graph.y + graph.height - 35 };
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
            sharedTopicGroupIds: [],
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
  release();
  await expect(page.getByRole('region', { name: 'Study map graph' })).toBeVisible();
  await page.unroute('**/api/study-map');
  await page.route('**/api/study-map', (route) =>
    route.fulfill({ status: 500, json: { error: 'Unavailable' } }),
  );
  await page.reload();
  await expect(page.getByText('The study map is unavailable.')).toBeVisible();
});

test('complete graph nodes have green borders while status pills do not, and shared-only groups explain their topics', async ({
  page,
}) => {
  const title = 'Mathematics for Machine Learning';
  await page.route('**/api/study-map', (route) =>
    route.fulfill({
      json: {
        groups: [
          { id: 'maths', title, kind: 'course', sharedTopicGroupIds: [] },
          { id: 'shared', title: 'Shared course', kind: 'course', sharedTopicGroupIds: ['maths'] },
        ],
        nodes: [false, true].map((placedOut, i) => ({
          id: `done-${i}`,
          groupId: 'maths',
          title: placedOut ? 'Placed' : 'Done',
          status: 'complete',
          placedOut,
          lessonAvailable: true,
          missingPrereqTitles: [],
        })),
        edges: [],
      },
    }),
  );
  await page.goto('/map');
  const graph = page.getByRole('region', { name: 'Study map graph', exact: true });
  const complete = page
    .getByRole('group', { name: 'Filter by status' })
    .getByRole('button', { name: 'Complete', exact: true });
  await expect(complete).toHaveAttribute('aria-pressed', 'false');
  await expect(complete).not.toHaveClass(/border-emerald|ring-2/);
  await expect(complete).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)');
  for (const name of ['Done: Complete', 'Placed: Placed out']) {
    const node = graph.getByRole('link', { name, exact: true });
    await expect(node).toHaveClass(/bg-emerald-50/);
    await expect(node).toHaveClass(/border-emerald-700/);
    const nodeColors = await node.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.backgroundColor, style.color];
    });
    expect(nodeColors).toEqual(
      await complete.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.backgroundColor, style.color];
      }),
    );
    await expect(node.locator('[data-slot="badge"]')).not.toHaveClass(/border-emerald/);
    await expect(node.locator('[data-slot="badge"]')).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)');
  }
  await complete.click();
  await expect(complete).toHaveAttribute('aria-pressed', 'true');
  await expect(complete).toHaveClass(/ring-2/);
  await expect(complete).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)');
  await expect(page.getByText(`All topics are shown in ${title}.`, { exact: true })).toHaveCount(2);
  const label = graph.locator('[data-id="title:maths"] [data-map-title]');
  await expect(label).toHaveText(title);
  expect(await label.evaluate((element) => getComputedStyle(element).textOverflow)).not.toBe(
    'ellipsis',
  );
  await page.route('**/api/study-map', (route) =>
    route.fulfill({
      json: {
        groups: [{ id: 'empty', title: 'Empty course', kind: 'course', sharedTopicGroupIds: [] }],
        nodes: [],
        edges: [],
      },
    }),
  );
  await page.reload();
  await expect(page.locator('[data-id="group:empty"]')).toBeVisible();
  await expect(page.getByText('No topics in this group.', { exact: true })).toHaveCount(2);
});

test('status chips toggle multiple map filters, filter lists, respect hover and reset with Clear', async ({
  page,
}) => {
  await page.route('**/api/study-map', (route) =>
    route.fulfill({
      json: {
        groups: ['one', 'two'].map((id) => ({
          id,
          title: id,
          kind: 'course',
          sharedTopicGroupIds: [],
        })),
        nodes: ['complete', 'in_progress', 'quiz', 'not_started', 'locked'].map((status) => ({
          id: status,
          title: `Topic ${status}`,
          groupId: status === 'locked' ? 'two' : 'one',
          status,
          placedOut: false,
          lessonAvailable: true,
          missingPrereqTitles: [],
        })),
        edges: [{ from: 'complete', to: 'quiz' }],
      },
    }),
  );
  await page.goto('/map');
  const filters = page.getByRole('group', { name: 'Filter by status' });
  const list = page.locator('[aria-label="Topics by group"]');
  await expect(list.locator('li')).toHaveCount(5);
  await expect(page.getByText('Quiz not passed', { exact: true })).toHaveCount(0);
  const progress = filters.getByRole('button', { name: 'In progress', exact: true });
  const complete = filters.getByRole('button', { name: 'Complete', exact: true });
  await expect(filters.getByRole('button', { name: 'Clear', exact: true })).toHaveCount(0);
  await progress.focus();
  await page.keyboard.press('Enter');
  await expect(progress).toHaveAttribute('aria-pressed', 'true');
  await expect(list.locator('li')).toHaveCount(2);
  await expect(list.getByText('Topic quiz', { exact: true })).toBeVisible();
  await expect(list.getByText('No topics match the filter.')).toBeVisible();
  await expect(page.locator('[data-id="complete"]')).toHaveCSS('opacity', '0.25');
  await expect(page.locator('[data-id="quiz"]')).toHaveCSS('opacity', '1');
  await page.locator('[data-id="complete"]').hover();
  await expect(page.locator('[data-id="complete"]')).toHaveCSS('opacity', '0.25');
  await expect(page.locator('.react-flow__edge-path')).toHaveCSS('opacity', '0.25');
  expect(
    await page
      .locator('.react-flow__edge-path')
      .evaluate((element) => element.getAttribute('style')),
  ).toContain('opacity: 0.25');
  await complete.click();
  await expect(complete).toHaveAttribute('aria-pressed', 'true');
  await expect(list.locator('li')).toHaveCount(3);
  await complete.focus();
  await page.keyboard.press(' ');
  await expect(complete).toHaveAttribute('aria-pressed', 'false');
  await expect(list.locator('li')).toHaveCount(2);
  await filters.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(list.locator('li')).toHaveCount(5);
  await expect(progress).toHaveAttribute('aria-pressed', 'false');
  await expect(filters.getByRole('button', { name: 'Clear', exact: true })).toHaveCount(0);
});

test('empty study map links to the course catalogue', async ({ page }) => {
  await db.delete(courseEnrollments);
  await page.goto('/map');
  await expect(page.getByText('Add a course to see your map.')).toBeVisible();
  await page.getByRole('link', { name: 'Browse courses', exact: true }).click();
  await expect(page).toHaveURL(/\/courses$/);
  await expect(page.getByRole('link', { name: 'View map', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Map', exact: true })).toBeVisible();
});
