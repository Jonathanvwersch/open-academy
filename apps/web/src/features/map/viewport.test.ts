import { expect, test } from 'vitest';
import type { GroupNode } from './layout.js';
import { initialMapViewport } from './viewport.js';

const group = (width: number, height: number): GroupNode => ({
  id: 'first',
  type: 'courseGroup',
  data: { title: 'First course' },
  position: { x: 700, y: 1400 },
  style: { width, height },
});

test.each([
  [1100, 600],
  [340, 520],
])('large maps open legibly at the first group at %ipx', (width, height) => {
  const viewport = initialMapViewport([group(3000, 5000)], width, height);
  expect(viewport).toEqual({ x: 24 - 700 * 0.75, y: 24 - 1400 * 0.75, zoom: 0.75 });
});

test('small maps fit without zooming beyond their natural size', () => {
  const viewport = initialMapViewport([group(300, 200)], 1100, 600);
  expect(viewport?.zoom).toBe(1);
  expect(700 + (viewport?.x ?? 0)).toBeGreaterThan(0);
  expect(1400 + (viewport?.y ?? 0)).toBeGreaterThan(0);
});

test('empty maps and unmeasured containers have no initial viewport', () => {
  expect(initialMapViewport([], 1100, 600)).toBeUndefined();
  expect(initialMapViewport([group(300, 200)], 0, 600)).toBeUndefined();
  expect(initialMapViewport([group(300, 200)], 1100, 0)).toBeUndefined();
});
