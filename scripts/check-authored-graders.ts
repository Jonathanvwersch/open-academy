import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { Exercise } from '../src/server/content/schemas.js';
import { ExerciseSchema } from '../src/server/content/schemas.js';
import { instantiateExercise, isTemplate } from '../src/server/content/templates.js';
import { gradeExercise } from '../src/server/grading/index.js';

const directory = resolve('content/exercises');
const files = (await readdir(directory)).filter((file) => file.endsWith('.yaml')).sort();
const failures: string[] = [];
let exerciseCount = 0;
let commonWrongCount = 0;

for (const file of files) {
  const raw = parse(await readFile(join(directory, file), 'utf8'));
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
    const authoredExercise = parsed.data;
    const exercise = isTemplate(authoredExercise)
      ? instantiateExercise(authoredExercise, 0).exercise
      : authoredExercise;
    const label = `${file} [${exercise.id}]`;
    const answer = authoredAnswer(exercise);
    if (answer === undefined) {
      failures.push(`${label}: no authored correct answer could be selected`);
      continue;
    }
    const correctResult = await gradeExercise(exercise, answer, { random: () => 0.371 });
    exerciseCount += 1;
    if (correctResult.status !== 'graded' || correctResult.correct !== 1) {
      failures.push(`${label}: authored answer graded ${JSON.stringify(correctResult)}`);
    }

    if (
      exercise.type === 'numeric' ||
      exercise.type === 'expression' ||
      (exercise.type === 'code_read' && 'answer' in exercise)
    ) {
      for (const wrong of exercise.common_wrong ?? []) {
        if (!('answer' in wrong)) continue;
        const wrongResult = await gradeExercise(exercise, wrong.answer, { random: () => 0.371 });
        commonWrongCount += 1;
        if (wrongResult.status !== 'graded' || wrongResult.mistake_category !== wrong.category) {
          failures.push(
            `${label}: common_wrong ${JSON.stringify(wrong.answer)} expected ${wrong.category}, got ${JSON.stringify(wrongResult)}`,
          );
        }
      }
    }
  }
}

console.log(
  `Checked ${exerciseCount} authored answers and ${commonWrongCount} common_wrong answers across ${files.length} exercise files.`,
);
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
}

function authoredAnswer(exercise: Exercise): unknown {
  switch (exercise.type) {
    case 'mc':
      return exercise.options.filter((option) => option.correct).map((option) => option.id);
    case 'numeric':
    case 'expression':
      return exercise.type === 'numeric' && !('answer' in exercise) ? undefined : exercise.answer;
    case 'text':
    case 'code_complete':
      return exercise.accept[0];
    case 'code_read':
      return 'answer' in exercise ? exercise.answer : exercise.accept[0];
    case 'debug':
      return {
        line: exercise.buggy_line,
        fixId: exercise.fix_options.find((option) => option.correct)?.id,
      };
    case 'explain':
      return {
        text: exercise.exemplar,
        metCriteria: exercise.rubric.map((criterion) => criterion.id),
      };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
