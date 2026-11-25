import { describe, expect, it } from 'vitest';
import type { ContentIndex, IndexedConcept } from '../course/types.js';
import { buildEncompassingIndex } from './encompassing.js';

function concept(
  id: string,
  prereqs: IndexedConcept['prereqs'] = [],
  encompassings?: IndexedConcept['encompassings'],
): IndexedConcept {
  return {
    id,
    title: id,
    description: '',
    difficulty: 1,
    est_minutes: 1,
    goal_weight: 1,
    dimensions: ['conceptual'],
    prereqs,
    ...(encompassings === undefined ? {} : { encompassings }),
    related: [],
    objectives: [{ text: id, dimension: 'conceptual' }],
    projects: [],
    sources: [],
    status: 'stub',
    domain: 'math',
    contentVersion: 'test',
  };
}

function index(concepts: IndexedConcept[]) {
  return buildEncompassingIndex({
    concepts,
    conceptsById: new Map(concepts.map((entry) => [entry.id, entry])),
  } as ContentIndex);
}

describe('buildEncompassingIndex', () => {
  it('uses an explicit edge weight', () => {
    const weights = index([
      concept('base'),
      concept('advanced', [{ id: 'base', strength: 'hard' }], [{ id: 'base', weight: 0.8 }]),
    ]);

    expect(weights.weight('advanced', 'base')).toBe(0.8);
  });

  it('infers weights through a two-hop chain by multiplying edge weights', () => {
    const weights = index([
      concept('base'),
      concept('middle', [{ id: 'base', strength: 'hard' }], [{ id: 'base', weight: 0.6 }]),
      concept('advanced', [{ id: 'middle', strength: 'hard' }], [{ id: 'middle', weight: 0.5 }]),
    ]);

    expect(weights.weight('advanced', 'base')).toBeCloseTo(0.3);
  });

  it('takes the maximum over multiple paths', () => {
    const weights = index([
      concept('base'),
      concept('left', [{ id: 'base', strength: 'hard' }], [{ id: 'base', weight: 0.6 }]),
      concept('right', [{ id: 'base', strength: 'hard' }], [{ id: 'base', weight: 0.5 }]),
      concept(
        'advanced',
        [
          { id: 'left', strength: 'hard' },
          { id: 'right', strength: 'hard' },
        ],
        [
          { id: 'left', weight: 0.5 },
          { id: 'right', weight: 0.8 },
        ],
      ),
    ]);

    expect(weights.weight('advanced', 'base')).toBeCloseTo(0.4);
  });

  it('lets an explicit edge override an inferred edge', () => {
    const weights = index([
      concept('base'),
      concept('middle', [{ id: 'base', strength: 'hard' }], [{ id: 'base', weight: 0.4 }]),
      concept(
        'advanced',
        [{ id: 'middle', strength: 'hard' }],
        [
          { id: 'middle', weight: 0.5 },
          { id: 'base', weight: 0.8 },
        ],
      ),
    ]);

    expect(weights.weight('advanced', 'base')).toBe(0.8);
  });

  it('uses the direct-prerequisite fallback and omits soft prerequisites', () => {
    const weights = index([
      concept('hard'),
      concept('soft'),
      concept('advanced', [
        { id: 'hard', strength: 'hard' },
        { id: 'soft', strength: 'soft' },
      ]),
    ]);

    expect(weights.weight('advanced', 'hard')).toBe(0.5);
    expect(weights.weight('advanced', 'soft')).toBe(0);
  });

  it('returns descendants as the inverse of positive ancestor weights', () => {
    const weights = index([
      concept('base'),
      concept('middle', [{ id: 'base', strength: 'hard' }], [{ id: 'base', weight: 0.6 }]),
      concept('advanced', [{ id: 'middle', strength: 'hard' }], [{ id: 'middle', weight: 0.5 }]),
    ]);

    expect(weights.ancestors('advanced')).toEqual(
      new Map([
        ['middle', 0.5],
        ['base', 0.3],
      ]),
    );
    expect(weights.descendants('base')).toEqual(
      new Map([
        ['middle', 0.6],
        ['advanced', 0.3],
      ]),
    );
  });
});
