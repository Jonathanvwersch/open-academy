import { instantiateExercise, isTemplate } from '../course/templates.js';
import type { ContentIndex, IndexedExercise } from '../course/types.js';

export function exerciseFor(content: ContentIndex, exerciseId: string, seed = 0): IndexedExercise {
  const indexed = content.exercisesById.get(exerciseId);
  if (!indexed) throw new Error(`Unknown exercise ${exerciseId}`);
  if (!isTemplate(indexed)) return indexed;
  return {
    ...instantiateExercise(indexed, seed).exercise,
    concept: indexed.concept,
    contentVersion: indexed.contentVersion,
  } as IndexedExercise;
}

export function answerFor(content: ContentIndex, exerciseId: string, seed = 0): unknown {
  const exercise = exerciseFor(content, exerciseId, seed);
  if (exercise.type === 'explain' && 'exemplar' in exercise) {
    return { text: exercise.exemplar };
  }
  if (exercise.type === 'mc') {
    const correct = exercise.options.filter((option) => option.correct).map((option) => option.id);
    return exercise.multi ? correct : correct[0];
  }
  if (exercise.type === 'debug') {
    return {
      line: exercise.buggy_line,
      fixId: exercise.fix_options.find((option) => option.correct)?.id,
    };
  }
  if ('answer' in exercise) return exercise.answer;
  if ('accept' in exercise) return exercise.accept[0];
  return { text: 'A correct explanation.' };
}

export function seededWrongAnswerFor(content: ContentIndex, exerciseId: string, seed = 0): unknown {
  const exercise = exerciseFor(content, exerciseId, seed);
  if (exercise.type !== 'mc') return answerFor(content, exerciseId, seed);
  const incorrect = exercise.options.find((option) => !option.correct);
  if (!incorrect) return answerFor(content, exerciseId, seed);
  return exercise.multi ? [incorrect.id] : incorrect.id;
}

export function wrongAnswerFor(content: ContentIndex, exerciseId: string, seed = 0): unknown {
  const exercise = exerciseFor(content, exerciseId, seed);
  if (exercise.type === 'mc') return seededWrongAnswerFor(content, exerciseId, seed);
  if (exercise.type === 'explain') {
    return { text: 'An intentionally incomplete response.', metCriteria: [] };
  }
  if (exercise.type === 'expression' && 'answer' in exercise) {
    return `${exercise.answer} + 1`;
  }
  if (exercise.type === 'numeric' && 'answer' in exercise) {
    const answer = Number(exercise.answer);
    return Number.isFinite(answer) ? answer + 1_000_003 : 'not the answer';
  }
  if (exercise.type === 'debug') {
    const incorrectFix = exercise.fix_options.find((option) => !option.correct);
    return {
      line: exercise.buggy_line,
      fixId: incorrectFix?.id ?? exercise.fix_options[0]?.id,
    };
  }
  return 'not the answer';
}
