import { expect, test } from 'vitest';
import { eigenInputs, eigenTransform } from './eigen-transform.js';

test('the animation starts at each input and ends at its matrix product', () => {
  for (const input of eigenInputs) {
    expect(eigenTransform(input.point, 0)).toEqual(input.point);
    expect(eigenTransform(input.point, 1)).toEqual(input.output);
  }
});

test('eigenvector directions stay fixed throughout the transformation', () => {
  for (const progress of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    const [x, y] = eigenTransform([1, 1], progress);
    expect(x).toBeCloseTo(y);
    const unchanged = eigenTransform([1, -1], progress);
    expect(unchanged[0]).toBeCloseTo(1);
    expect(unchanged[1]).toBeCloseTo(-1);
    const [, turnedY] = eigenTransform([1, 0], progress);
    expect(turnedY).toBeGreaterThan(0);
  }
});

test('the intermediate grid transformation remains linear', () => {
  for (const t of [0, 0.5, 1]) {
    const a = eigenTransform([2, -1], t);
    const b = eigenTransform([-1, 3], t);
    expect(eigenTransform([1, 2], t)).toEqual([a[0] + b[0], a[1] + b[1]]);
  }
});
