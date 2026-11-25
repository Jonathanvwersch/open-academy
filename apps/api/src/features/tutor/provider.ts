import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { ContentIndex } from '../../content/types.js';
import { repositoryPath } from '../../paths.js';
import {
  type ExplanationContext,
  type RubricJudgement,
  RubricJudgementSchema,
  type TutorContext,
  type TutorLevel,
  type TutorReply,
  TutorReplySchema,
} from './schemas.js';

export type TutorPromptId = 'tutor-system' | 'rubric-grader';

const promptCache = new Map<TutorPromptId, string>();

function promptPath(name: string): URL | string {
  const local = new URL(`./prompts/${name}`, import.meta.url);
  if (existsSync(local)) return local;
  const bundled = repositoryPath('apps/api/dist-vercel/prompts', name);
  return existsSync(bundled)
    ? bundled
    : repositoryPath('apps/api/src/features/tutor/prompts', name);
}

function readPrompt(id: TutorPromptId): string {
  let prompt = promptCache.get(id);
  if (prompt === undefined) {
    prompt = readFileSync(promptPath(`${id}.md`), 'utf8');
    promptCache.set(id, prompt);
  }
  return prompt;
}

export function renderTutorSystemPrompt(content: ContentIndex): string {
  const curriculum = content.curriculum;
  const prompt = readPrompt('tutor-system').replaceAll(
    '{{subject}}',
    curriculum?.subject?.title ?? 'the subject of this course',
  );
  const tutorContext = curriculum?.subject?.tutor_context;
  return tutorContext
    ? `${prompt.trimEnd()}\n\nAbout this learner and subject: ${tutorContext}`
    : prompt;
}

export function tutorPromptVersion(id: TutorPromptId, content?: ContentIndex): string {
  const prompt =
    id === 'tutor-system' && content ? renderTutorSystemPrompt(content) : readPrompt(id);
  return createHash('sha256').update(prompt).digest('hex').slice(0, 12);
}

export type TutorInputMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export function buildTutorInput(
  ctx: TutorContext,
  level: TutorLevel,
  content: ContentIndex,
): TutorInputMessage[] {
  const { history = [], question, ...rest } = ctx;
  return [
    { role: 'system', content: renderTutorSystemPrompt(content) },
    ...history.map(
      (message): TutorInputMessage => ({
        role: message.role === 'tutor' ? 'assistant' : 'user',
        content: message.content,
      }),
    ),
    {
      role: 'system',
      content: `Context for the learner's next message — what is on their screen right now:\n${JSON.stringify({ ...rest, requested_help_level: level })}`,
    },
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
  respond(
    ctx: TutorContext,
    level: TutorLevel,
    content: ContentIndex,
    signal?: AbortSignal,
  ): Promise<TutorResult<TutorReply>>;
  gradeExplanation(ctx: ExplanationContext): Promise<TutorResult<RubricJudgement>>;
}

export class OpenAIProvider implements TutorProvider {
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    readonly model: string,
    client?: OpenAI,
  ) {
    this.client = client ?? new OpenAI({ apiKey, timeout: 100_000, maxRetries: 0 });
  }

  async respond(
    ctx: TutorContext,
    level: TutorLevel,
    content: ContentIndex,
    signal?: AbortSignal,
  ): Promise<TutorResult<TutorReply>> {
    const response = await this.client.responses.parse(
      {
        model: this.model,
        input: buildTutorInput(ctx, level, content),
        text: { format: zodTextFormat(TutorReplySchema, 'tutor_reply') },
        max_output_tokens: 4000,
      },
      { signal },
    );
    if (response.status === 'incomplete' || response.output_parsed === null) {
      const reason = response.incomplete_details?.reason;
      const error = new Error(
        reason ? `Tutor response incomplete: ${reason}` : 'Tutor response incomplete',
      );
      Object.assign(error, { reason });
      throw error;
    }
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
        { role: 'system', content: readPrompt('rubric-grader') },
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

  async respond(
    _ctx: TutorContext,
    _level: TutorLevel,
    _content: ContentIndex,
    _signal?: AbortSignal,
  ): Promise<TutorResult<TutorReply>> {
    if (this.failure) throw this.failure;
    return { value: TutorReplySchema.parse(this.reply), usage: null };
  }

  async gradeExplanation(_ctx: ExplanationContext): Promise<TutorResult<RubricJudgement>> {
    if (this.failure) throw this.failure;
    return { value: RubricJudgementSchema.parse(this.judgement), usage: null };
  }
}

const e2eDiagramReplies: ReadonlyMap<string, string> = new Map([
  [
    'Draw a projection onto a line.',
    [
      'The projection is the point Q where the perpendicular from P meets the line.',
      '',
      '```svg',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 188" aria-label="Point P projects perpendicularly onto point Q on the line">',
      '<rect width="320" height="188" rx="8" fill="#F8FAFC"/>',
      '<path d="M24 138H296" stroke="#475569" stroke-width="2"/>',
      '<path d="M48 138L205 40M195 41L205 40L201 50" fill="none" stroke="#2563EB" stroke-width="3" stroke-linejoin="round"/>',
      '<path d="M205 40V138" stroke="#0F766E" stroke-width="2" stroke-dasharray="5 4"/>',
      '<path d="M193 138V126H205" fill="none" stroke="#0F766E" stroke-width="2"/>',
      '<circle cx="205" cy="40" r="4" fill="#2563EB"/>',
      '<circle cx="205" cy="138" r="4" fill="#0F766E"/>',
      '<text x="215" y="38" fill="#1E3A8A" font-size="16" font-family="sans-serif">P</text>',
      '<text x="198" y="163" fill="#115E59" font-size="16" font-family="sans-serif">Q</text>',
      '<text x="266" y="163" fill="#475569" font-size="14" font-family="sans-serif">line</text>',
      '</svg>',
      '```',
    ].join('\n'),
  ],
  [
    'Draw a projection with an incomplete SVG.',
    [
      'The projection is the foot of the perpendicular.',
      '',
      '```svg',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 188" aria-label="Incomplete projection">',
      '<path',
    ].join('\n'),
  ],
]);

export class E2ETutorProvider implements TutorProvider {
  readonly model = 'academy-e2e';

  async respond(
    ctx: TutorContext,
    _level: TutorLevel,
    _content: ContentIndex,
    _signal?: AbortSignal,
  ): Promise<TutorResult<TutorReply>> {
    return {
      value: TutorReplySchema.parse({
        message_md:
          e2eDiagramReplies.get(ctx.question ?? '') ?? `Tutor reply to: ${ctx.question ?? ''}`,
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
