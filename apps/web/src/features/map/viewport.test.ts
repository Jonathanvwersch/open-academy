import { expect, test } from 'vitest';
import type { GroupNode } from './layout.js';
import { initialMapViewport, mapFitViewOptions } from './viewport.js';

const group = (width: number, height: number): GroupNode => ({
  id: 'first',
  type: 'courseGroup',
  data: { title: 'First' },
  position: { x: 700, y: 1400 },
  style: { width, height },
});

test.each([
  { width: 1100, zoom: 0.9 },
  { width: 640, zoom: 0.9 },
  { width: 639, zoom: 0.8 },
  { width: 390, zoom: 0.8 },
])('opens at zoom $zoom with 24px first-frame insets for a $width px canvas', ({ width, zoom }) => {
  const first = group(3000, 5000);
  const viewport = initialMapViewport([first, group(7000, 10000)], width, 600);
  expect(viewport).toEqual({ x: 24 - 700 * zoom, y: 24 - 1400 * zoom, zoom });
  expect(first.position.x * zoom + Number(viewport?.x)).toBe(24);
  expect(first.position.y * zoom + Number(viewport?.y)).toBe(24);
});

test.each([
  [268, 188],
  [3000, 5000],
])('opening zoom does not depend on frame size %i by %i', (width, height) => {
  expect(initialMapViewport([group(width, height)], 1100, 600)?.zoom).toBe(0.9);
  expect(initialMapViewport([group(width, height)], 390, 600)?.zoom).toBe(0.8);
});

test('Fit view can still zoom out to show the whole graph', () => {
  expect(mapFitViewOptions).toEqual({ padding: 0.1, minZoom: 0.01, maxZoom: 1 });
});

test('empty maps and unmeasured containers have no initial viewport', () => {
  expect(initialMapViewport([], 1100, 600)).toBeUndefined();
  expect(initialMapViewport([group(300, 200)], 0, 600)).toBeUndefined();
  expect(initialMapViewport([group(300, 200)], 1100, 0)).toBeUndefined();
});
