import { type EvalFunction, type MathNode, parse } from 'mathjs';
import type { Exercise } from './schemas.js';

type TemplateNumericExercise = Extract<Exercise, { type: 'numeric'; answer_expr: string }> & {
  params: Record<string, ParameterRange>;
};
type ConcreteNumericExercise = Extract<Exercise, { type: 'numeric'; answer: number }>;
type ParameterRange = { min: number; max: number; step: number };
type CompiledExpression = EvalFunction;
const compiledExpressions = new Map<string, CompiledExpression>();

export function isTemplate(exercise: Exercise): exercise is TemplateNumericExercise {
  return exercise.type === 'numeric' && 'answer_expr' in exercise;
}

function compileExpression(expression: string, names: Set<string>): CompiledExpression {
  const key = `${[...names].sort().join(',')}\u0000${expression}`;
  const cached = compiledExpressions.get(key);
  if (cached) return cached;
  const node = parse(expression) as MathNode;
  const unknownNames = new Set<string>();
  node
    .filter((child, path, parent) => {
      if (!('isSymbolNode' in child) || child.isSymbolNode !== true) return false;
      return !(path === 'fn' && parent.type === 'FunctionNode');
    })
    .forEach((child) => {
      const name = 'name' in child && typeof child.name === 'string' ? child.name : '';
      if (!names.has(name)) unknownNames.add(name);
    });
  if (unknownNames.size) {
    throw new Error(
      `unknown identifier${unknownNames.size > 1 ? 's' : ''}: ${[...unknownNames].join(', ')}`,
    );
  }
  const compiled = node.compile();
  compiledExpressions.set(key, compiled);
  return compiled;
}

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function sample(range: ParameterRange, random: () => number): number {
  const count = Math.floor((range.max - range.min) / range.step + 1e-10) + 1;
  return range.min + Math.floor(random() * count) * range.step;
}

export function formatTemplateNumber(value: number): string {
  if (!Number.isFinite(value) || Object.is(value, -0) || value === 0) return '0';
  const rounded = Number(value.toPrecision(6));
  if (Object.is(rounded, -0) || rounded === 0) return '0';
  return rounded
    .toString()
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
}

function substituteText(text: string, scope: Record<string, number>): string {
  return text.replace(/\{\{=\s*([^}]+?)\s*\}\}/g, (_match, expression: string) => {
    const compiled = compileExpression(expression, new Set(Object.keys(scope)));
    const result = compiled.evaluate(scope);
    if (typeof result !== 'number' || !Number.isFinite(result)) {
      throw new Error(`placeholder expression did not return a finite number: ${expression}`);
    }
    return formatTemplateNumber(result);
  });
}

function substituteStrings<T>(value: T, scope: Record<string, number>): T {
  if (typeof value === 'string') return substituteText(value, scope) as T;
  if (Array.isArray(value)) return value.map((item) => substituteStrings(item, scope)) as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        key === 'answer_expr' || key === 'constraints' || key === 'params'
          ? child
          : substituteStrings(child, scope),
      ]),
    ) as T;
  }
  return value;
}

export function instantiateExercise(
  exercise: TemplateNumericExercise,
  seed: number,
): { exercise: ConcreteNumericExercise; params: Record<string, number> };
export function instantiateExercise(
  exercise: Exercise,
  seed: number,
): { exercise: Exercise; params: Record<string, number> };
export function instantiateExercise(
  exercise: Exercise,
  seed: number,
): { exercise: Exercise; params: Record<string, number> } {
  if (!isTemplate(exercise)) return { exercise, params: {} };

  const parameterNames = new Set(Object.keys(exercise.params));
  const answer = compileExpression(exercise.answer_expr, parameterNames);
  const constraints = (exercise.constraints ?? []).map((expression) =>
    compileExpression(expression, parameterNames),
  );
  const commonWrong = (exercise.common_wrong ?? []).map((wrong) =>
    'answer_expr' in wrong ? compileExpression(wrong.answer_expr, parameterNames) : undefined,
  );
  const random = makeRandom(seed);
  let params: Record<string, number> | undefined;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const sampled = Object.fromEntries(
      Object.entries(exercise.params).map(([name, range]) => [name, sample(range, random)]),
    );
    if (constraints.every((constraint) => constraint.evaluate(sampled) === true)) {
      params = sampled;
      break;
    }
  }
  if (!params)
    throw new Error(`could not satisfy constraints for template "${exercise.id}" in 200 attempts`);

  const answerValue = answer.evaluate(params);
  if (typeof answerValue !== 'number' || !Number.isFinite(answerValue)) {
    throw new Error(
      `answer expression for template "${exercise.id}" did not return a finite number`,
    );
  }
  const commonWrongValues = commonWrong.map((compiled, index) =>
    compiled
      ? compiled.evaluate(params)
      : (() => {
          const wrong = exercise.common_wrong?.[index];
          return wrong && 'answer' in wrong ? wrong.answer : undefined;
        })(),
  );
  if (
    commonWrongValues.some(
      (value) => value !== undefined && (typeof value !== 'number' || !Number.isFinite(value)),
    )
  ) {
    throw new Error(
      `common-wrong expression for template "${exercise.id}" did not return a finite number`,
    );
  }

  const substituted = substituteStrings(exercise, params) as Record<string, unknown>;
  const concreteCommonWrong = exercise.common_wrong?.map((wrong, index) => ({
    answer: commonWrongValues[index] as number,
    tolerance: wrong.tolerance,
    category: wrong.category,
    feedback: substituteText(wrong.feedback, params as Record<string, number>),
  }));
  delete substituted.answer_expr;
  delete substituted.params;
  delete substituted.constraints;
  const concrete = { ...substituted, answer: answerValue, common_wrong: concreteCommonWrong };
  return { exercise: concrete as Exercise, params };
}
