import { beforeAll, describe, expect, it } from 'vitest';
import { loadContent } from '../../content/load.js';
import { SelfCheckExplanationGrader } from './explain.js';
import type { ExplainExercise } from './types.js';

describe('SelfCheckExplanationGrader', () => {
  let exercise: ExplainExercise;

  beforeAll(async () => {
    const content = await loadContent();
    const candidate = content.exercisesById.get('gd-explain-lr');
    if (candidate?.type !== 'explain') throw new Error('Missing explain exercise');
    exercise = candidate;
  });

  it('gives partial credit when some required criteria are selected', async () => {
    const requiredIds = exercise.rubric.filter(({ required }) => required).map(({ id }) => id);
    expect(requiredIds.length).toBeGreaterThan(1);

    const result = await new SelfCheckExplanationGrader().grade(exercise, {
      metCriteria: requiredIds.slice(0, 1),
    });

    expect(result).toMatchObject({ status: 'graded', correct: 0.5 });
  });

  it('scores all required criteria without optional criteria affecting the result', async () => {
    const requiredIds = exercise.rubric.filter(({ required }) => required).map(({ id }) => id);
    const optionalCriteria = exercise.rubric.filter(({ required }) => !required);
    expect(requiredIds).not.toHaveLength(0);
    expect(optionalCriteria).not.toHaveLength(0);

    const result = await new SelfCheckExplanationGrader().grade(exercise, {
      metCriteria: requiredIds,
    });

    expect(result).toMatchObject({ status: 'graded', correct: 1 });
  });

  it('gives no credit when no criteria are selected', async () => {
    const result = await new SelfCheckExplanationGrader().grade(exercise, { metCriteria: [] });

    expect(result).toMatchObject({ status: 'graded', correct: 0 });
  });
});
