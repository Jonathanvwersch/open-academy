import type { MistakeCategory } from '../content/schemas.js';
import type { Correctness, GradeResult } from './types.js';

export interface NumericTolerance {
  abs?: number;
  rel?: number;
}

export function graded(
  correct: Correctness,
  feedback: string,
  options: {
    graded_by?: 'deterministic' | 'self';
    mistake_category?: MistakeCategory;
    credit?: number;
  } = {},
): GradeResult {
  return {
    status: 'graded',
    correct,
    credit: options.credit ?? correct,
    feedback,
    graded_by: options.graded_by ?? 'deterministic',
    ...(options.mistake_category ? { mistake_category: options.mistake_category } : {}),
  };
}

export function invalid(feedback: string): GradeResult {
  return { status: 'invalid', feedback, graded_by: 'deterministic' };
}

export function parseNumeric(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  const numberPattern = '[+-]?(?:(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?)';
  if (!new RegExp(`^${numberPattern}$`, 'i').test(normalized)) {
    const fractionMatch = normalized.match(
      new RegExp(`^(${numberPattern})\\s*\\/\\s*(${numberPattern})$`, 'i'),
    );
    if (!fractionMatch) {
      return undefined;
    }
    const numerator = Number(fractionMatch[1]);
    const denominator = Number(fractionMatch[2]);
    const quotient = numerator / denominator;
    return Number.isFinite(quotient) ? quotient : undefined;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function numericEqual(
  actual: number,
  expected: number,
  tolerance: NumericTolerance = {},
): boolean {
  const absolute = tolerance.abs ?? 1e-6;
  const relative = tolerance.rel ?? 0;
  return (
    Math.abs(actual - expected) <=
    Math.max(absolute, relative * Math.max(Math.abs(actual), Math.abs(expected)))
  );
}

export function normalizeText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}
