import { z } from 'zod';

export const IdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const ProjectEvidenceIdSchema = z.string().regex(/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/);

export const DimensionSchema = z.enum(['conceptual', 'math', 'implementation', 'transfer']);
export const ExerciseRoleSchema = z.enum(['core', 'transfer', 'review', 'diagnostic', 'check']);
export const MistakeCategorySchema = z.enum([
  'missing_prerequisite',
  'misunderstood_definition',
  'math_error',
  'incorrect_reasoning',
  'implementation_error',
  'misapplied_technique',
  'recall_failure',
  'incomplete_explanation',
]);

const ScheduleSchema = z
  .object({
    mon: z.number().int().positive(),
    tue: z.number().int().positive(),
    wed: z.number().int().positive(),
    thu: z.number().int().positive(),
    fri: z.number().int().positive(),
    sat: z.number().int().positive(),
    sun: z.number().int().positive(),
  })
  .strict();

export const CurriculumSchema = z
  .object({
    schedule: ScheduleSchema,
    domains: z
      .array(
        z
          .object({
            id: IdSchema,
            title: z.string().min(1),
            description: z.string(),
          })
          .strict(),
      )
      .min(1),
    weeks: z
      .array(
        z
          .object({
            week: z.number().int().positive(),
            title: z.string().min(1),
            concepts: z.array(IdSchema),
            project: IdSchema.optional(),
            saturday: z.string().optional(),
            sunday: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    goals: z
      .array(
        z
          .object({
            id: IdSchema,
            text: z.string().min(1),
            concepts: z.array(IdSchema).min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const ConceptSchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1),
    description: z.string(),
    difficulty: z.number().int().min(1).max(5),
    est_minutes: z.number().positive(),
    week: z.number().int().positive(),
    goal_weight: z.number().min(0).max(3),
    dimensions: z.array(DimensionSchema).min(1),
    prereqs: z
      .array(
        z
          .object({
            id: IdSchema,
            strength: z.enum(['hard', 'soft']).default('hard'),
          })
          .strict(),
      )
      .default([]),
    related: z.array(IdSchema).default([]),
    objectives: z
      .array(
        z
          .object({
            text: z.string().min(1),
            dimension: DimensionSchema,
          })
          .strict(),
      )
      .min(1),
    projects: z.array(IdSchema).default([]),
    sources: z
      .array(
        z
          .object({
            title: z.string().min(1),
            url: z.string().url(),
          })
          .strict(),
      )
      .default([]),
    status: z.enum(['authored', 'stub']),
  })
  .strict();

export const ConceptFileSchema = z
  .object({
    domain: IdSchema,
    concepts: z.array(ConceptSchema),
  })
  .strict();

export const NotationSchema = z
  .object({
    terms: z
      .array(
        z
          .object({
            id: IdSchema,
            label: z.string().min(1),
            match: z.array(z.string().min(1)).min(1),
            introduced_by: z.array(IdSchema).min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

const BlockMarkdownSchema = z
  .object({
    kind: z.enum(['objective', 'intuition', 'example', 'math', 'worked', 'summary']),
    md: z.string(),
  })
  .strict();

const BlockExerciseSchema = z
  .object({
    kind: z.enum(['check', 'faded']),
    exercise: IdSchema,
    md: z.string().optional(),
  })
  .strict();

export const LessonSchema = z
  .object({
    concept: IdSchema,
    version: z.number().int().positive(),
    blocks: z.array(z.union([BlockMarkdownSchema, BlockExerciseSchema])).min(1),
    fast_path: z
      .array(
        z.enum([
          'objective',
          'intuition',
          'example',
          'check',
          'math',
          'worked',
          'faded',
          'summary',
        ]),
      )
      .default([]),
  })
  .strict();

const CommonExerciseSchema = z.object({
  id: IdSchema,
  dimension: DimensionSchema,
  role: ExerciseRoleSchema,
  difficulty: z.number().int().min(1).max(5),
  est_minutes: z.number().positive(),
  prompt: z.string().min(1),
  hints: z.array(z.string().min(1)).max(4).default([]),
  solution: z.string().min(1),
  misconceptions: z
    .array(
      z
        .object({
          category: MistakeCategorySchema,
          feedback: z.string().min(1),
        })
        .strict(),
    )
    .optional(),
});

const OptionSchema = z
  .object({
    id: IdSchema,
    text: z.string().min(1),
    correct: z.boolean(),
    feedback: z.string().optional(),
    category: MistakeCategorySchema.optional(),
  })
  .strict();

const NumericToleranceSchema = z
  .object({
    abs: z.number().nonnegative().optional(),
    rel: z.number().nonnegative().optional(),
  })
  .strict();

const CommonWrongNumericSchema = z
  .object({
    answer: z.number(),
    tolerance: NumericToleranceSchema.optional(),
    category: MistakeCategorySchema,
    feedback: z.string().min(1),
  })
  .strict();

const CommonWrongExpressionSchema = z
  .object({
    answer: z.string().min(1),
    category: MistakeCategorySchema,
    feedback: z.string().min(1),
  })
  .strict();

const MultipleChoiceExerciseSchema = CommonExerciseSchema.extend({
  type: z.literal('mc'),
  options: z.array(OptionSchema).min(2),
  multi: z.boolean().default(false),
}).strict();

const NumericExerciseSchema = CommonExerciseSchema.extend({
  type: z.literal('numeric'),
  answer: z.number(),
  tolerance: NumericToleranceSchema,
  common_wrong: z.array(CommonWrongNumericSchema).optional(),
}).strict();

const ExpressionExerciseSchema = CommonExerciseSchema.extend({
  type: z.literal('expression'),
  answer: z.string().min(1),
  variables: z.record(z.string(), z.tuple([z.number(), z.number()])),
  common_wrong: z.array(CommonWrongExpressionSchema).optional(),
}).strict();

const TextExerciseSchema = CommonExerciseSchema.extend({
  type: z.literal('text'),
  accept: z.array(z.string().min(1)).min(1),
  regex: z.string().optional(),
}).strict();

const CodeReadNumericExerciseSchema = CommonExerciseSchema.extend({
  type: z.literal('code_read'),
  code: z.string().min(1),
  answer: z.number(),
  tolerance: NumericToleranceSchema,
  common_wrong: z.array(CommonWrongNumericSchema).optional(),
}).strict();

const CodeReadTextExerciseSchema = CommonExerciseSchema.extend({
  type: z.literal('code_read'),
  code: z.string().min(1),
  accept: z.array(z.string().min(1)).min(1),
  regex: z.string().optional(),
}).strict();

const CodeCompleteExerciseSchema = CommonExerciseSchema.extend({
  type: z.literal('code_complete'),
  code: z.string().min(1),
  accept: z.array(z.string().min(1)).min(1),
}).strict();

const DebugExerciseSchema = CommonExerciseSchema.extend({
  type: z.literal('debug'),
  code: z.string().min(1),
  buggy_line: z.number().int().positive(),
  fix_options: z.array(OptionSchema).min(2),
}).strict();

const ExplainExerciseSchema = CommonExerciseSchema.extend({
  type: z.literal('explain'),
  rubric: z
    .array(
      z
        .object({
          id: IdSchema,
          criterion: z.string().min(1),
          weight: z.number().positive(),
          required: z.boolean().default(false),
        })
        .strict(),
    )
    .min(1),
  exemplar: z.string().min(1),
}).strict();

export const ExerciseSchema = z.union([
  MultipleChoiceExerciseSchema,
  NumericExerciseSchema,
  ExpressionExerciseSchema,
  TextExerciseSchema,
  CodeReadNumericExerciseSchema,
  CodeReadTextExerciseSchema,
  CodeCompleteExerciseSchema,
  DebugExerciseSchema,
  ExplainExerciseSchema,
]);

export const ExerciseFileSchema = z
  .object({
    concept: IdSchema,
    exercises: z.array(ExerciseSchema),
  })
  .strict();

export const DiagnosticSchema = z
  .object({
    domains: z
      .array(
        z
          .object({
            domain: IdSchema,
            ladder: z.array(IdSchema).min(1),
            start: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const ProjectSchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1),
    week: z.number().int().positive(),
    status: z.enum(['authored', 'stub']),
    est_hours: z.number().positive(),
    objective: z.string().min(1),
    background: z.string(),
    prereqs: z.array(IdSchema).default([]),
    tasks: z
      .array(
        z
          .object({
            id: IdSchema,
            title: z.string().min(1),
            md: z.string(),
          })
          .strict(),
      )
      .default([]),
    acceptance: z.array(z.string()).default([]),
    tests: z
      .array(
        z
          .object({
            id: ProjectEvidenceIdSchema,
            concepts: z.array(IdSchema).min(1),
            dimension: DimensionSchema,
          })
          .strict(),
      )
      .default([]),
    metrics: z
      .array(
        z
          .object({
            id: ProjectEvidenceIdSchema,
            label: z.string().min(1),
            threshold: z.number(),
            direction: z.enum(['below', 'above']),
          })
          .strict(),
      )
      .default([]),
    reflection: z.array(IdSchema).default([]),
    follow_up: z.array(z.string()).default([]),
  })
  .strict();

export type Curriculum = z.infer<typeof CurriculumSchema>;
export type Concept = z.infer<typeof ConceptSchema>;
export type NotationRegistry = z.infer<typeof NotationSchema>;
export type Lesson = z.infer<typeof LessonSchema>;
export type Exercise = z.infer<typeof ExerciseSchema>;
export type Diagnostic = z.infer<typeof DiagnosticSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type Dimension = z.infer<typeof DimensionSchema>;
export type ExerciseRole = z.infer<typeof ExerciseRoleSchema>;
export type MistakeCategory = z.infer<typeof MistakeCategorySchema>;
