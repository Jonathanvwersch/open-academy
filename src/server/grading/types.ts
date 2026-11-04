import type { MistakeCategory } from '../content/schemas.js';

export type Correctness = 0 | 0.5 | 1;

export type GradeResult =
  | {
      status: 'invalid' | 'self_check_required';
      feedback: string;
      graded_by: 'deterministic' | 'self';
      rubric?: Array<{ id: string; criterion: string; required: boolean }>;
    }
  | {
      status: 'graded';
      correct: Correctness;
      credit: number;
      feedback: string;
      graded_by: 'deterministic' | 'self';
      mistake_category?: MistakeCategory;
    };

export interface GraderOptions {
  random?: () => number;
  explanationGrader?: ExplanationGrader;
}

export interface ExplanationGrader {
  grade(exercise: ExplainExercise, answer: unknown): Promise<GradeResult>;
}

export type ExplainExercise = Extract<
  import('../content/schemas.js').Exercise,
  { type: 'explain' }
>;
export type NumericExercise = Extract<
  import('../content/schemas.js').Exercise,
  { type: 'numeric'; answer: number }
>;
export type ExpressionExercise = Extract<
  import('../content/schemas.js').Exercise,
  { type: 'expression' }
>;
export type TextExercise = Extract<import('../content/schemas.js').Exercise, { type: 'text' }>;
export type CodeCompleteExercise = Extract<
  import('../content/schemas.js').Exercise,
  { type: 'code_complete' }
>;
export type CodeReadExercise = Extract<
  import('../content/schemas.js').Exercise,
  { type: 'code_read' }
>;
export type DebugExercise = Extract<import('../content/schemas.js').Exercise, { type: 'debug' }>;
