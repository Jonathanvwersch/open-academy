import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import {
  type ExplanationContext,
  type RubricJudgement,
  RubricJudgementSchema,
  type TutorContext,
  type TutorLevel,
  type TutorReply,
  TutorReplySchema,
} from './schemas.js';

const tutorPrompt = readFileSync(
  join(process.cwd(), 'src/server/tutor/prompts/tutor-system.md'),
  'utf8',
);
const rubricPrompt = readFileSync(
  join(process.cwd(), 'src/server/tutor/prompts/rubric-grader.md'),
  'utf8',
);

export type TutorPromptId = 'tutor-system' | 'rubric-grader';

export const TUTOR_PROMPT_VERSIONS: Record<TutorPromptId, string> = {
  'tutor-system': createHash('sha256').update(tutorPrompt).digest('hex').slice(0, 12),
  'rubric-grader': createHash('sha256').update(rubricPrompt).digest('hex').slice(0, 12),
};

export type TutorInputMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export function buildTutorInput(ctx: TutorContext, level: TutorLevel): TutorInputMessage[] {
  const { history = [], question, ...rest } = ctx;
  return [
    { role: 'system', content: tutorPrompt },
    {
      role: 'user',
      content: JSON.stringify({ ...rest, requested_help_level: level }),
    },
    ...history.map(
      (message): TutorInputMessage => ({
        role: message.role === 'tutor' ? 'assistant' : 'user',
        content: message.content,
      }),
    ),
    {
      role: 'user',
      content: question?.trim()
        ? question
        : '(No chat message: the learner pressed the hint button. Give help at requested_help_level.)',
    },
  ];
}

export interface TutorUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface TutorResult<Value> {
  value: Value;
  usage: TutorUsage | null;
}

export interface TutorProvider {
  readonly model: string;
  respond(ctx: TutorContext, level: TutorLevel): Promise<TutorResult<TutorReply>>;
  gradeExplanation(ctx: ExplanationContext): Promise<TutorResult<RubricJudgement>>;
}

export class OpenAIProvider implements TutorProvider {
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    readonly model: string,
    client?: OpenAI,
  ) {
    this.client = client ?? new OpenAI({ apiKey, timeout: 20_000, maxRetries: 0 });
  }

  async respond(ctx: TutorContext, level: TutorLevel): Promise<TutorResult<TutorReply>> {
    const response = await this.client.responses.parse({
      model: this.model,
      input: buildTutorInput(ctx, level),
      text: { format: zodTextFormat(TutorReplySchema, 'tutor_reply') },
      max_output_tokens: 900,
    });
    return {
      value: TutorReplySchema.parse(response.output_parsed),
      usage: response.usage
        ? {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          }
        : null,
    };
  }

  async gradeExplanation(ctx: ExplanationContext): Promise<TutorResult<RubricJudgement>> {
    const response = await this.client.responses.parse({
      model: this.model,
      input: [
        { role: 'system', content: rubricPrompt },
        { role: 'user', content: JSON.stringify(ctx) },
      ],
      text: { format: zodTextFormat(RubricJudgementSchema, 'rubric_judgement') },
      max_output_tokens: 600,
    });
    return {
      value: RubricJudgementSchema.parse(response.output_parsed),
      usage: response.usage
        ? {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          }
        : null,
    };
  }
}

export class FakeProvider implements TutorProvider {
  readonly model = 'fake-provider';

  constructor(
    private readonly reply: TutorReply = {
      message_md: 'Which part of the expression changes when you vary the input?',
      misconception: null,
      suggests_review_of: [],
    },
    private readonly judgement: RubricJudgement = {
      criteria: [],
      feedback_md: 'Review the rubric.',
    },
    private readonly failure?: Error,
  ) {}

  async respond(_ctx: TutorContext, _level: TutorLevel): Promise<TutorResult<TutorReply>> {
    if (this.failure) throw this.failure;
    return { value: TutorReplySchema.parse(this.reply), usage: null };
  }

  async gradeExplanation(_ctx: ExplanationContext): Promise<TutorResult<RubricJudgement>> {
    if (this.failure) throw this.failure;
    return { value: RubricJudgementSchema.parse(this.judgement), usage: null };
  }
}

export class E2ETutorProvider implements TutorProvider {
  readonly model = 'academy-e2e';

  async respond(ctx: TutorContext): Promise<TutorResult<TutorReply>> {
    return {
      value: TutorReplySchema.parse({
        message_md: `Tutor reply to: ${ctx.question ?? ''}`,
        misconception: null,
        suggests_review_of: [],
      }),
      usage: null,
    };
  }

  async gradeExplanation(ctx: ExplanationContext): Promise<TutorResult<RubricJudgement>> {
    return {
      value: RubricJudgementSchema.parse({
        criteria: ctx.rubric.map(({ id }) => ({
          id,
          judgement: 'partial',
          evidence: 'E2E partial rubric judgement.',
        })),
        feedback_md: 'E2E summary feedback.',
      }),
      usage: null,
    };
  }
}

export function createTutorProvider(input: {
  apiKey?: string;
  model: string;
}): TutorProvider | null {
  return input.apiKey ? new OpenAIProvider(input.apiKey, input.model) : null;
}
