import { beforeAll, describe, expect, it } from 'vitest';
import { loadContent } from '../../src/content/load.js';
import type { ContentIndex } from '../../src/content/types.js';
import { buildProgress } from '../../src/learning/progress.js';
import { initialMastery } from '../../src/learning/types.js';

let content: ContentIndex;

beforeAll(async () => {
  content = await loadContent('tests/fixtures/content');
});

function progressInput(
  overrides: Partial<Parameters<typeof buildProgress>[0]> = {},
): Parameters<typeof buildProgress>[0] {
  return {
    content,
    records: [],
    events: [],
    attempts: [],
    flags: [],
    submissions: [],
    sessions: [],
    xpEvents: [],
    now: new Date('2026-01-02T00:30:00.000Z'),
    timeZone: 'UTC',
    ...overrides,
  };
}

describe('buildProgress', () => {
  it('counts a goal only when every authored concept dimension is independent or retained', () => {
    const concept = content.concepts.find(
      (item) => item.status === 'authored' && item.dimensions.length > 1,
    );
    const stub = content.concepts.find((item) => item.status === 'stub');
    const goal = content.curriculum?.goals[0];
    if (!concept || !stub || !goal || !content.curriculum) {
      throw new Error('Fixture must include authored and stub goal concepts');
    }
    const scopedContent: ContentIndex = {
      ...content,
      curriculum: {
        ...content.curriculum,
        goals: [{ ...goal, concepts: [concept.id, stub.id] }],
      },
    };
    const records = concept.dimensions.map((dimension, index) => ({
      ...initialMastery(concept.id, dimension),
      state: index === 0 ? ('independent' as const) : ('retained' as const),
    }));

    expect(buildProgress(progressInput({ content: scopedContent, records })).goal).toEqual({
      mastered: 1,
      total: 1,
    });
    expect(
      buildProgress(
        progressInput({
          content: scopedContent,
          records: records.map((record, index) =>
            index === records.length - 1 ? { ...record, state: 'assisted' as const } : record,
          ),
        }),
      ).goal,
    ).toEqual({ mastered: 0, total: 1 });
  });

  it('includes active-session elapsed time in total study hours', () => {
    const now = new Date('2026-01-02T00:30:00.000Z');
    const result = buildProgress(
      progressInput({
        now,
        sessions: [
          { activeSeconds: 0, status: 'active', startedAt: new Date(now.getTime() - 30 * 60_000) },
          { activeSeconds: 90 * 60, status: 'completed', startedAt: null },
        ],
      }),
    );
    expect(result.hours).toBe(2);
  });

  it('stops elapsed-time accumulation for abandoned sessions without awarding a streak', () => {
    const result = buildProgress(
      progressInput({
        now: new Date('2026-01-02T00:30:00.000Z'),
        sessions: [
          {
            activeSeconds: 600,
            status: 'abandoned',
            startedAt: new Date('2026-01-01T12:00:00.000Z'),
          },
          {
            activeSeconds: 600,
            status: 'completed',
            startedAt: new Date('2026-01-02T00:10:00.000Z'),
          },
        ],
      }),
    );
    expect(result.hours).toBeCloseTo(1 / 3);
    expect(result.streakDays).toBe(0);
  });

  it('does not accrue stale active-session time after the learner local day changes', () => {
    const result = buildProgress(
      progressInput({
        now: new Date('2026-01-02T08:30:00.000Z'),
        timeZone: 'America/Los_Angeles',
        sessions: [
          {
            activeSeconds: 600,
            status: 'active',
            startedAt: new Date('2026-01-02T07:30:00.000Z'),
          },
        ],
      }),
    );
    expect(result.hours).toBeCloseTo(1 / 6);
  });

  it('counts a streak using XP dates recorded in the learner timezone', () => {
    const result = buildProgress(
      progressInput({
        now: new Date('2026-01-02T00:30:00.000Z'),
        timeZone: 'America/Los_Angeles',
        xpEvents: [
          { amount: 10, localDate: '2026-01-01' },
          { amount: 10, localDate: '2025-12-31' },
        ],
        sessions: [
          {
            activeSeconds: 600,
            status: 'completed',
            startedAt: new Date('2026-01-01T20:00:00.000Z'),
          },
          {
            activeSeconds: 600,
            status: 'completed',
            startedAt: new Date('2025-12-31T20:00:00.000Z'),
          },
        ],
      }),
    );
    expect(result.streakDays).toBe(2);
  });

  it('counts mastery states only for authored concepts in each domain', () => {
    const concept = content.concepts.find(
      (item) => item.status === 'authored' && item.dimensions.length > 0,
    );
    if (!concept) throw new Error('Fixture must include an authored concept');
    const dimension = concept.dimensions[0];
    if (!dimension) throw new Error('Authored concept must include a dimension');
    const totalDimensions = content.concepts
      .filter((item) => item.domain === concept.domain && item.status === 'authored')
      .reduce((total, item) => total + item.dimensions.length, 0);
    const record = {
      ...initialMastery(concept.id, dimension),
      state: 'assisted' as const,
    };
    const domain = buildProgress(progressInput({ records: [record] })).domains.find(
      (item) => item.id === concept.domain,
    );
    expect(domain?.counts.assisted).toBe(1);
    expect(domain?.counts.not_assessed).toBe(totalDimensions - 1);
  });

  it('counts explicit not-assessed mastery and ignores undeclared dimensions', () => {
    const concept = content.concepts.find(
      (item) => item.status === 'authored' && !item.dimensions.includes('transfer'),
    );
    if (!concept) throw new Error('Fixture must include a concept without a transfer dimension');
    const dimension = concept.dimensions[0];
    if (!dimension) throw new Error('Authored concept must include a dimension');
    const totalDimensions = content.concepts
      .filter((item) => item.domain === concept.domain && item.status === 'authored')
      .reduce((total, item) => total + item.dimensions.length, 0);
    const records = [
      { ...initialMastery(concept.id, dimension), state: 'not_assessed' as const },
      { ...initialMastery(concept.id, 'transfer'), state: 'retained' as const },
    ];

    const domain = buildProgress(progressInput({ records })).domains.find(
      (item) => item.id === concept.domain,
    );
    expect(domain?.counts.not_assessed).toBe(totalDimensions);
    expect(domain?.counts.retained).toBe(0);
  });
});
