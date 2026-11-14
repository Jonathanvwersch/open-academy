import { expect, test } from 'vitest';
import type { GroupNode } from './layout.js';
import { initialMapViewport } from './viewport.js';

const group = (width: number, height: number, y = 24): GroupNode => ({
  id: `group:${y}`,
  type: 'courseGroup',
  data: { title: 'Course' },
  position: { x: 24, y },
  style: { width, height },
});

test('desktop fits every band and its title inside the canvas even with fifty topics', () => {
  const groups = [group(2400, 900), group(2000, 800, 988), group(2600, 1300, 1852)];
  const viewport = initialMapViewport(groups, 720, 600);
  expect(viewport).toBeDefined();
  if (!viewport) return;
  expect(viewport.zoom).toBeLessThan(0.75);
  for (const band of groups) {
    expect(band.position.x * viewport.zoom + viewport.x).toBeGreaterThan(0);
    expect(band.position.y * viewport.zoom + viewport.y).toBeGreaterThan(0);
    expect((band.position.x + Number(band.style?.width)) * viewport.zoom + viewport.x).toBeLessThan(
      720,
    );
    expect(
      (band.position.y + Number(band.style?.height)) * viewport.zoom + viewport.y,
    ).toBeLessThan(600);
  }
});

test('mobile fits the first band width rather than shrinking to fit later bands', () => {
  const first = group(1600, 400);
  const viewport = initialMapViewport([first, group(4000, 3000, 488)], 340, 520);
  expect(viewport?.zoom).toBeCloseTo(340 / (1600 * 1.4));
  if (!viewport) return;
  expect(first.position.y * viewport.zoom + viewport.y).toBe(16);
  expect(first.position.x * viewport.zoom + viewport.x).toBeGreaterThan(0);
  expect((first.position.x + 1600) * viewport.zoom + viewport.x).toBeLessThan(340);
});

test('small maps never open larger than the maximum load zoom', () => {
  expect(initialMapViewport([group(268, 188)], 1100, 600)?.zoom).toBe(0.85);
});

test('empty maps and unmeasured containers have no initial viewport', () => {
  expect(initialMapViewport([], 1100, 600)).toBeUndefined();
  expect(initialMapViewport([group(300, 200)], 0, 600)).toBeUndefined();
  expect(initialMapViewport([group(300, 200)], 1100, 0)).toBeUndefined();
});
