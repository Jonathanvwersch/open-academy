export interface ClientExercise {
  id: string;
  type: string;
  multi?: boolean;
  lesson_only?: boolean;
  hintCount?: number;
  prompt: string;
  options?: Array<{ id: string; text: string }>;
  buggy_line?: number;
  code?: string;
  fix_options?: Array<{ id: string; text: string; correct?: boolean }>;
  rubric?: Array<{ id: string; criterion: string; required: boolean }>;
}

export interface AnswerOptions {
  selected: string[];
  correct?: string[];
}

export type ExercisePayload = ClientExercise;
