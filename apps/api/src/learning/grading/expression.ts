import type { MathNode } from 'mathjs';
import { parse as parseExpression } from 'mathjs';
import { graded, invalid, numericEqual } from './shared.js';
import type { ExpressionExercise, GradeResult } from './types.js';

interface Sample {
  scope: Record<string, number>;
  keyValue: number;
}

type CommonWrongExpression = NonNullable<ExpressionExercise['common_wrong']>[number];

const expressionFunctions = [
  'exp',
  'log',
  'ln',
  'sqrt',
  'sin',
  'cos',
  'tan',
  'abs',
  'tanh',
  'sigmoid',
  'max',
  'min',
] as const;
const expressionFunctionSet = new Set<string>(expressionFunctions);
const expressionConstants = new Set(['e', 'pi']);

export function normalizeLearnerExpression(input: string, variables: string[]): string {
  const variableSet = new Set(variables);
  const normalized = input
    .replaceAll('²', '^2')
    .replaceAll('³', '^3')
    .replace(/[−–]/g, '-')
    .replace(/[×·⋅]/g, '*')
    .replaceAll('σ', variableSet.has('sigma') ? 'sigma' : 'σ')
    .replaceAll('ŷ', variableSet.has('yhat') ? 'yhat' : 'ŷ')
    .replaceAll('y\u0302', variableSet.has('yhat') ? 'yhat' : 'y\u0302');

  return normalized.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (identifier, offset, source: string) => {
    if (identifier === 'ln') return 'log';
    if (
      variableSet.has(identifier) ||
      expressionFunctionSet.has(identifier) ||
      expressionConstants.has(identifier)
    ) {
      return identifier;
    }

    if (source[offset + identifier.length] === '(') {
      for (const fn of expressionFunctions) {
        if (identifier.length <= fn.length || !identifier.endsWith(fn)) continue;
        const prefix = identifier.slice(0, -fn.length);
        const prefixVariables = splitVariables(prefix, variables);
        if (prefixVariables) {
          return `${prefixVariables.join('*')}*${fn === 'ln' ? 'log' : fn}`;
        }
      }
    }

    return splitVariables(identifier, variables)?.join('*') ?? identifier;
  });
}

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
  const variables = Object.keys(exercise.variables);
  const learnerExpression = normalizeLearnerExpression(answer, variables);
  try {
    expected = parseExpression(exercise.answer) as MathNode;
    learner = parseExpression(learnerExpression) as MathNode;
    commonWrong = (exercise.common_wrong ?? []).map((entry) => ({
      node: parseExpression(normalizeLearnerExpression(entry.answer, variables)) as MathNode,
      category: entry.category,
      feedback: entry.feedback,
    }));
  } catch {
    return invalid('Expression could not be parsed. Fix the syntax and submit again.');
  }
  const unknown = findUnknownSymbols(learner, variables)[0];
  if (unknown) {
    return invalid(
      `Unknown symbol '${unknownSymbolPart(unknown, variables)}'. Use the variables: ${variables.join(', ')}.`,
    );
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

function splitVariables(identifier: string, variables: string[]): string[] | undefined {
  const candidates = [...variables].sort((left, right) => right.length - left.length);
  const memo = new Map<number, string[] | null>();

  function splitFrom(offset: number): string[] | undefined {
    if (offset === identifier.length) return [];
    if (memo.has(offset)) return memo.get(offset) ?? undefined;

    for (const candidate of candidates) {
      if (!identifier.startsWith(candidate, offset)) continue;
      const rest = splitFrom(offset + candidate.length);
      if (rest) {
        const result = [candidate, ...rest];
        memo.set(offset, result);
        return result;
      }
    }
    memo.set(offset, null);
    return undefined;
  }

  return splitFrom(0);
}

function findUnknownSymbols(node: MathNode, variables: string[]): string[] {
  const symbols = new Set<string>();
  const functionNames = new Set<string>();
  node.traverse((child) => {
    if (child.type === 'FunctionNode') {
      const functionNode = child as MathNode & { fn: MathNode };
      if (functionNode.fn.type === 'SymbolNode') {
        functionNames.add((functionNode.fn as MathNode & { name: string }).name);
      }
    }
    if (child.type === 'SymbolNode') {
      symbols.add((child as MathNode & { name: string }).name);
    }
  });

  const variableSet = new Set(variables);
  return [...symbols].filter(
    (name) =>
      !variableSet.has(name) &&
      !expressionFunctionSet.has(name) &&
      !expressionConstants.has(name) &&
      !functionNames.has(name),
  );
}

function unknownSymbolPart(symbol: string, variables: string[]): string {
  for (let splitAt = 1; splitAt < symbol.length; splitAt += 1) {
    const prefix = symbol.slice(0, splitAt);
    const suffix = symbol.slice(splitAt);
    const prefixIsVariables = splitVariables(prefix, variables) !== undefined;
    const suffixIsVariables = splitVariables(suffix, variables) !== undefined;
    if (!prefixIsVariables && suffixIsVariables) return prefix;
    if (prefixIsVariables && !suffixIsVariables) return suffix;
  }
  return symbol;
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
