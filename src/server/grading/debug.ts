import { graded } from './shared.js';
import type { DebugExercise, GradeResult } from './types.js';

export function gradeDebug(exercise: DebugExercise, answer: unknown): GradeResult {
  if (!isRecord(answer)) {
    return graded(0, 'Choose the buggy line and a fix.');
  }
  const line = Number(answer.line);
  const fixId = typeof answer.fixId === 'string' ? answer.fixId : '';
  const lineCorrect = line === exercise.buggy_line;
  const fix = exercise.fix_options.find((option) => option.id === fixId);
  const fixCorrect = fix?.correct === true;
  if (lineCorrect && fixCorrect) {
    return graded(1, fix?.feedback ?? 'Both the line and fix are right.');
  }
  if (lineCorrect || fixCorrect) {
    return graded(0.5, fix?.feedback ?? 'One part is right; identify both the line and its fix.');
  }
  return graded(0, fix?.feedback ?? 'Review the trace and identify the faulty update.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
