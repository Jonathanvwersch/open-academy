import { describe, expect, it } from 'vitest';
import { loadContent } from '../../content/load.js';
import { SelfCheckExplanationGrader } from './explain.js';

describe('SelfCheckExplanationGrader', () => {
  it('scores required criteria without optional criteria affecting the result', async () => {
    const content = await loadContent();
    const exercise = content.exercisesById.get('gd-explain-lr');
    if (exercise?.type !== 'explain') throw new Error('Missing explain exercise');

    const result = await new SelfCheckExplanationGrader().grade(exercise, {
      metCriteria: exercise.rubric.filter((criterion) => criterion.required).map(({ id }) => id),
    });

    expect(result).toMatchObject({ status: 'graded', correct: 1 });
  });
});
