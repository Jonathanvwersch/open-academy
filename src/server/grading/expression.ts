import type { MathNode } from 'mathjs';
import { parse as parseExpression } from 'mathjs';
import { graded, invalid, numericEqual } from './shared.js';
import type { ExpressionExercise, GradeResult } from './types.js';

interface Sample {
  scope: Record<string, number>;
  keyValue: number;
}

type CommonWrongExpression = NonNullable<ExpressionExercise['common_wrong']>[number];

export function gradeExpression(
  exercise: ExpressionExercise,
  answer: unknown,
  options: { random?: () => number } = {},
): GradeResult {
  if (typeof answer !== 'string' || answer.trim().length === 0) {
    return invalid('Enter a mathematical expression.');
  }

  let expected: MathNode;
  let learner: MathNode;
  let commonWrong: Array<{
    node: MathNode;
    category: CommonWrongExpression['category'];
    feedback: string;
  }> = [];
  try {
    expected = parseExpression(exercise.answer) as MathNode;
    learner = parseExpression(answer) as MathNode;
    commonWrong = (exercise.common_wrong ?? []).map((entry) => ({
      node: parseExpression(entry.answer) as MathNode,
      category: entry.category,
      feedback: entry.feedback,
    }));
  } catch {
    return invalid('Expression could not be parsed. Fix the syntax and submit again.');
  }

  const random = options.random ?? Math.random;
  const samples = sampleValues(exercise, expected, random);
  if (samples === undefined) {
    return invalid('The answer key has no finite values in its declared sample ranges.');
  }
  if (matchesSamples(learner, samples, exercise, random)) {
    return graded(1, 'Equivalent expression.');
  }
  for (const wrong of commonWrong) {
    if (matchesExpressions(learner, wrong.node, samples)) {
      return graded(0, wrong.feedback, { mistake_category: wrong.category });
    }
  }
  return graded(0, 'The expression does not match the expected result at the sampled values.');
}

function sampleValues(
  exercise: ExpressionExercise,
  expected: MathNode,
  random: () => number,
): Sample[] | undefined {
  const samples: Sample[] = [];
  for (let index = 0; index < 20; index += 1) {
    const scope: Record<string, number> = {};
    for (const [name, range] of Object.entries(exercise.variables)) {
      const draw = random();
      const boundedDraw = Number.isFinite(draw) ? Math.min(1, Math.max(0, draw)) : 0.5;
      scope[name] = range[0] + (range[1] - range[0]) * boundedDraw;
    }
    const keyValue = evaluate(expected, scope);
    if (keyValue !== undefined) {
      samples.push({ scope, keyValue });
    }
  }
  return samples.length > 0 ? samples : undefined;
}

function matchesSamples(
  node: MathNode,
  samples: Sample[],
  exercise: ExpressionExercise,
  random: () => number,
): boolean {
  const variables = Object.keys(exercise.variables);
  let tested = 0;
  for (const sample of samples) {
    const valueScope = { ...sample.scope };
    for (const name of variables) {
      if (!(name in valueScope)) {
        const range = exercise.variables[name];
        const draw = random();
        valueScope[name] = range[0] + (range[1] - range[0]) * Math.min(1, Math.max(0, draw));
      }
    }
    const actual = evaluate(node, valueScope);
    if (actual === undefined) {
      return false;
    }
    tested += 1;
    if (!numericEqual(actual, sample.keyValue, { rel: 1e-6, abs: 1e-9 })) {
      return false;
    }
  }
  return tested > 0;
}

function matchesExpressions(left: MathNode, right: MathNode, samples: Sample[]): boolean {
  for (const sample of samples) {
    const leftValue = evaluate(left, sample.scope);
    const rightValue = evaluate(right, sample.scope);
    if (
      leftValue === undefined ||
      rightValue === undefined ||
      !numericEqual(leftValue, rightValue, { rel: 1e-6, abs: 1e-9 })
    ) {
      return false;
    }
  }
  return samples.length > 0;
}

function evaluate(node: MathNode, scope: Record<string, number>): number | undefined {
  try {
    const result: unknown = node.compile().evaluate(scope);
    return typeof result === 'number' && Number.isFinite(result) ? result : undefined;
  } catch {
    return undefined;
  }
}
