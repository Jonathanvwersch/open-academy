import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadLayout, mergeLineShapes, type Shape } from './page-layout-skeleton.js';

afterEach(() => vi.unstubAllGlobals());

function shape(overrides: Partial<Shape> = {}): Shape {
  return {
    x: 0,
    y: 0,
    width: 10,
    height: 8,
    radius: 4,
    kind: 'content',
    ...overrides,
  };
}

describe('mergeLineShapes', () => {
  it('merges abutting fragments on the same line', () => {
    expect(
      mergeLineShapes([
        shape({ x: 10, y: 20, width: 20 }),
        shape({ x: 30, y: 20, width: 15, radius: 2 }),
      ]),
    ).toEqual([shape({ x: 10, y: 20, width: 35, radius: 2 })]);
  });

  it('keeps fragments on different lines separate', () => {
    expect(mergeLineShapes([shape({ x: 0, y: 0 }), shape({ x: 0, y: 16 })])).toHaveLength(2);
  });

  it('keeps fragments separated by a 20 pixel gap apart', () => {
    expect(mergeLineShapes([shape({ x: 0, width: 10 }), shape({ x: 30, width: 10 })])).toHaveLength(
      2,
    );
  });

  it('does not merge or alter frames', () => {
    const firstFrame = shape({ x: 10, y: 10, width: 20, kind: 'frame' });
    const secondFrame = shape({ x: 30, y: 10, width: 20, kind: 'frame' });
    const result = mergeLineShapes([
      firstFrame,
      shape({ x: 0, y: 0, width: 10 }),
      secondFrame,
      shape({ x: 10, y: 0, width: 10 }),
    ]);

    expect(result.filter((item) => item.kind === 'frame')).toEqual([firstFrame, secondFrame]);
    expect(result.filter((item) => item.kind === 'content')).toEqual([
      shape({ x: 0, y: 0, width: 20 }),
    ]);
  });

  it('produces order-independent output and repeats merges until stable', () => {
    const fragments = [
      shape({ x: 0, y: -2, width: 10, height: 4, radius: 4 }),
      shape({ x: 0, y: -1, width: 10, height: 6, radius: 3 }),
      shape({ x: 0, y: -2.2, width: 10, height: 11, radius: 2 }),
    ];
    const expected = [shape({ x: 0, y: -2.2, width: 10, height: 11, radius: 2 })];

    expect(mergeLineShapes(fragments)).toEqual(expected);
    expect(mergeLineShapes([...fragments].reverse())).toEqual(expected);
  });
  it('puts frames before content so cards paint underneath their text', () => {
    const frame = shape({ x: 0, y: 0, width: 100, height: 50, kind: 'frame' });
    const text = shape({ x: 10, y: 10, width: 20 });
    const result = mergeLineShapes([text, frame]);
    expect(result.map((item) => item.kind)).toEqual(['frame', 'content']);
  });

  it('keeps rules unchanged between frames and content', () => {
    const frame = shape({ kind: 'frame' });
    const rule = shape({ y: 10, height: 1, radius: 0, kind: 'rule' });
    const content = shape({ y: 20 });
    const result = mergeLineShapes([content, rule, frame]);

    expect(result).toEqual([frame, rule, content]);
    expect(result[1]).toBe(rule);
  });
});

it('rejects cached layouts with an unknown shape kind', () => {
  vi.stubGlobal('sessionStorage', {
    getItem: () =>
      JSON.stringify({
        invalid: {
          height: 100,
          shapes: [{ x: 0, y: 0, width: 10, height: 8, radius: 4, kind: 'unknown' }],
        },
      }),
  });

  expect(loadLayout('invalid')).toBeUndefined();
});
