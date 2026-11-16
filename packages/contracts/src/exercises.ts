export interface ClientExercise {
  id: string;
  concept: string;
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

export interface RubricFeedbackItem {
  id: string;
  criterion: string;
  judgement?: 'met' | 'partial' | 'missing';
  required?: boolean;
}

export interface AttemptResponse extends Record<string, unknown> {
  activityCompleted?: boolean;
  answerOptions?: AnswerOptions;
  attemptId?: string;
  attemptNo?: number;
  correct?: number;
  feedback?: string;
  followUp?: boolean;
  rubric?: RubricFeedbackItem[];
  retryAllowed?: boolean;
  exemplar?: string;
  solution?: string;
  status?: string;
  yourAnswer?: string;
}

export type ExercisePayload = ClientExercise;
