import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type MathNode, parse as parseMath } from 'mathjs';
import { parse as parseYaml } from 'yaml';
import { ExerciseSchema } from '../src/content/schemas.js';
import { instantiateExercise, isTemplate } from '../src/content/templates.js';
import { gradeNumeric } from '../src/learning/grading/numeric.js';
import { numericEqual } from '../src/learning/grading/shared.js';
import { repositoryPath } from '../src/paths.js';

const exerciseFiles = [
  'tokenization.yaml',
  'embeddings.yaml',
  'attention.yaml',
  'multi-head-attention.yaml',
  'positional-encoding.yaml',
  'causal-masking.yaml',
  'transformer-block.yaml',
  'autoregressive-lm.yaml',
  'pretraining.yaml',
  'sft.yaml',
  'mixture-of-experts.yaml',
  'eigen-svd.yaml',
  'lora.yaml',
  'llm-evaluation.yaml',
  'reward-models.yaml',
];
const exerciseDirectory = repositoryPath('content', 'exercises');
const failures: string[] = [];
const numberWords: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
};
let templateCount = 0;
let combinationCount = 0;
let validCombinationCount = 0;
let constraintRejectedCount = 0;
let commonWrongCount = 0;
let finalRoundingCount = 0;
let intermediateRoundingCount = 0;

for (const file of exerciseFiles) {
  const path = join(exerciseDirectory, file);
  let raw: unknown;
  try {
    raw = parseYaml(await readFile(path, 'utf8'));
  } catch (error) {
    failures.push(`${file}: unable to parse YAML: ${errorMessage(error)}`);
    continue;
  }
  if (!isRecord(raw) || !Array.isArray(raw.exercises)) {
    failures.push(`${file}: missing exercise list`);
    continue;
  }

  for (const rawExercise of raw.exercises) {
    const parsed = ExerciseSchema.safeParse(rawExercise);
    if (!parsed.success) {
      failures.push(`${file}: invalid exercise structure`);
      continue;
    }
    const template = parsed.data;
    if (!isTemplate(template)) continue;
    templateCount += 1;

    const ranges = Object.entries(template.params);
    for (const params of parameterCombinations(ranges)) {
      combinationCount += 1;
      const fixedTemplate = {
        ...template,
        params: Object.fromEntries(
          Object.entries(params).map(([name, value]) => [
            name,
            { ...template.params[name], min: value, max: value },
          ]),
        ),
      };

      let exercise: ReturnType<typeof instantiateExercise>['exercise'];
      try {
        exercise = instantiateExercise(fixedTemplate, 0).exercise;
      } catch (error) {
        const message = errorMessage(error);
        if (message.startsWith(`could not satisfy constraints for template "${template.id}"`)) {
          constraintRejectedCount += 1;
          continue;
        }
        failures.push(`${file} [${template.id}] ${JSON.stringify(params)}: ${message}`);
        continue;
      }
      if (exercise.type !== 'numeric' || !('answer' in exercise)) {
        failures.push(`${file} [${template.id}]: instantiation did not produce a numeric answer`);
        continue;
      }

      validCombinationCount += 1;
      const label = `${file} [${template.id}] ${JSON.stringify(params)}`;
      const answer = exercise.answer;
      const correctGrade = gradeNumeric(exercise, answer);
      if (correctGrade.status !== 'graded' || correctGrade.correct !== 1) {
        failures.push(`${label}: answer key graded ${JSON.stringify(correctGrade)}`);
      }

      for (const [index, wrong] of (exercise.common_wrong ?? []).entries()) {
        commonWrongCount += 1;
        if (numericEqual(wrong.answer, answer, wrong.tolerance ?? exercise.tolerance)) {
          failures.push(`${label}: common_wrong[${index}] matches the answer key`);
        }
      }

      const precision = requestedPrecision(exercise.prompt);
      if (precision === undefined) continue;
      finalRoundingCount += 1;
      const roundedAnswer = Number(answer.toFixed(precision));
      const roundedGrade = gradeNumeric(exercise, roundedAnswer);
      if (roundedGrade.status !== 'graded' || roundedGrade.correct !== 1) {
        failures.push(
          `${label}: final answer rounded to ${precision} decimal places graded ${JSON.stringify(roundedGrade)}`,
        );
      }

      if (roundOnlyAtTheEnd(exercise.prompt)) continue;
      intermediateRoundingCount += 1;
      try {
        const roundedIntermediate = evaluateWithRoundedIntermediates(
          template.answer_expr,
          params,
          precision,
        );
        const intermediateGrade = gradeNumeric(exercise, roundedIntermediate);
        if (intermediateGrade.status !== 'graded' || intermediateGrade.correct !== 1) {
          failures.push(
            `${label}: intermediate-rounded answer ${roundedIntermediate} at ${precision} decimal places graded ${JSON.stringify(intermediateGrade)}`,
          );
        }
      } catch (error) {
        failures.push(`${label}: intermediate rounding failed: ${errorMessage(error)}`);
      }
    }
  }
}

console.log(
  `Enumerated ${combinationCount} parameter combinations across ${templateCount} numeric templates in ${exerciseFiles.length} exercise files; checked ${validCombinationCount} valid combinations and skipped ${constraintRejectedCount} combinations excluded by constraints.`,
);
console.log(
  `Checked ${commonWrongCount} common_wrong values, ${finalRoundingCount} final-rounded answers, and ${intermediateRoundingCount} intermediate-rounded answers.`,
);
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
}

function* parameterCombinations(
  ranges: Array<[string, { min: number; max: number; step: number }]>,
  index = 0,
  current: Record<string, number> = {},
): Generator<Record<string, number>> {
  if (index === ranges.length) {
    yield { ...current };
    return;
  }
  const entry = ranges[index];
  if (!entry) return;
  const [name, range] = entry;
  const count = Math.floor((range.max - range.min) / range.step + 1e-10) + 1;
  for (let stepIndex = 0; stepIndex < count; stepIndex += 1) {
    current[name] = Number((range.min + stepIndex * range.step).toPrecision(14));
    yield* parameterCombinations(ranges, index + 1, current);
  }
  delete current[name];
}

function requestedPrecision(prompt: string): number | undefined {
  const match = prompt.match(/\b(\d+|one|two|three|four|five|six)\s+decimal(?:\s+places?|s)\b/i);
  if (!match?.[1]) return undefined;
  return numberWords[match[1].toLowerCase()] ?? Number(match[1]);
}

function roundOnlyAtTheEnd(prompt: string): boolean {
  return /\bround only\b[\s\S]{0,60}\b(?:final|end)\b/i.test(prompt);
}

function evaluateWithRoundedIntermediates(
  expression: string,
  params: Record<string, number>,
  precision: number,
): number {
  const roundedTree = (parseMath(expression) as MathNode).transform((node) => {
    if (node.type !== 'OperatorNode' && node.type !== 'FunctionNode') return node;
    if (functionName(node) === 'round') return node;
    return parseMath(`round((${node.toString()}), ${precision})`) as MathNode;
  });
  const value = roundedTree.compile().evaluate(params);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('rounded expression did not return a finite number');
  }
  return value;
}

function functionName(node: MathNode): string | undefined {
  if (node.type !== 'FunctionNode' || !('fn' in node)) return undefined;
  const fn = node.fn;
  if (typeof fn !== 'object' || fn === null || !('name' in fn)) return undefined;
  return typeof fn.name === 'string' ? fn.name : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
