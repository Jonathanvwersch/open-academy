import { describe, expect, it } from 'vitest';
import { mergeLineShapes, type Shape } from './page-layout-skeleton.js';

function shape(overrides: Partial<Shape> = {}): Shape {
  return {
    x: 0,
    y: 0,
    width: 10,
    height: 8,
    radius: 4,
    frame: false,
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
    const firstFrame = shape({ x: 10, y: 10, width: 20, frame: true });
    const secondFrame = shape({ x: 30, y: 10, width: 20, frame: true });
    const result = mergeLineShapes([
      firstFrame,
      shape({ x: 0, y: 0, width: 10 }),
      secondFrame,
      shape({ x: 10, y: 0, width: 10 }),
    ]);

    expect(result.filter((item) => item.frame)).toEqual([firstFrame, secondFrame]);
    expect(result.filter((item) => !item.frame)).toEqual([shape({ x: 0, y: 0, width: 20 })]);
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
});
