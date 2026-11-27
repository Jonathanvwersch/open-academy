import type { TutorPrompt } from '@open-academy/engine/api';
import { z } from 'zod';

export const TutorReplySchema = z
  .object({
    message_md: z.string(),
    misconception: z.string().nullable(),
    suggests_review_of: z.array(z.string()),
  })
  .strict();

export const RubricJudgementSchema = z
  .object({
    criteria: z.array(
      z
        .object({
          id: z.string(),
          judgement: z.enum(['met', 'partial', 'missing']),
          evidence: z.string().nullable(),
        })
        .strict(),
    ),
    feedback_md: z.string(),
  })
  .strict();

export type TutorReply = z.infer<typeof TutorReplySchema>;
export type RubricJudgement = z.infer<typeof RubricJudgementSchema>;

export const TutorLevelSchema = z.enum(['nudge', 'hint', 'worked_step']);
export type TutorLevel = z.infer<typeof TutorLevelSchema>;

export type TutorContext = TutorPrompt & {
  question?: string;
  history: Array<{ role: 'learner' | 'tutor'; content: string }>;
};

export interface ExplanationContext {
  question: string;
  rubric: Array<{ id: string; criterion: string; weight: number; required: boolean }>;
  exemplar: string;
  answer: string;
}
