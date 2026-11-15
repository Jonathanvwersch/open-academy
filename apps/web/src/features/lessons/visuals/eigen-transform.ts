export type Point = readonly [number, number];

export const eigenInputs = [
  {
    point: [1, 1],
    output: [3, 3],
    label: '(1, 1)',
    result: 'Stays on its line; three times as long.',
  },
  { point: [1, -1], output: [1, -1], label: '(1, −1)', result: 'Stays exactly where it started.' },
  { point: [1, 0], output: [2, 1], label: '(1, 0)', result: 'Turns away from its original line.' },
] as const;

/** A continuous path from the identity to A = [[2, 1], [1, 2]]. */
export function eigenTransform([x, y]: Point, progress: number): Point {
  const t = Math.min(1, Math.max(0, progress));
  return [(1 + t) * x + t * y, t * x + (1 + t) * y];
}

export function coordinateLabel(point: Point): string {
  return `(${point.map((value) => Number(value.toFixed(2))).join(', ')})`.replaceAll('-', '−');
}
