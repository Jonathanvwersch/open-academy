import { z } from 'zod';

export const IdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const ProjectEvidenceIdSchema = z.string().regex(/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/);

export const DimensionSchema = z.enum(['conceptual', 'math', 'implementation', 'transfer']);
export const ExerciseRoleSchema = z.enum([
  'core',
  'transfer',
  'review',
  'diagnostic',
  'check',
  'practice',
  'basics',
]);
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

export const CourseUnitSchema = z
  .object({
    title: z.string().min(1),
    intro: z.string().optional(),
    project: IdSchema.optional(),
    papers: z.array(IdSchema).optional(),
    saturday: z.string().optional(),
    sunday: z.string().optional(),
    concepts: z.array(IdSchema).min(1),
  })
  .strict();

export const CourseSchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1),
    description: z.string(),
    subject: IdSchema.optional(),
    units: z.array(CourseUnitSchema).min(1),
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
    courses: z.array(IdSchema).min(1),
    default_course: IdSchema,
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
    subject: z
      .object({
        title: z.string().min(1),
        tutor_context: z.string().optional(),
      })
      .strict()
      .optional(),
    subjects: z
      .array(
        z
          .object({
            id: IdSchema,
            title: z.string().min(1),
          })
          .strict(),
      )
      .superRefine((subjects, context) => {
        const ids = new Set<string>();
        for (const [index, subject] of subjects.entries()) {
          if (ids.has(subject.id)) {
            context.addIssue({
              code: 'custom',
              message: `duplicate subject id "${subject.id}"`,
              path: [index, 'id'],
            });
          }
          ids.add(subject.id);
        }
      })
      .optional(),
    grounded: z.boolean().optional(),
  })
  .strict();

export const ConceptSchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1),
    description: z.string(),
    difficulty: z.number().int().min(1).max(5),
    est_minutes: z.number().positive(),
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
    confused_with: z.array(IdSchema).optional(),
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
            introduced_by: z.array(IdSchema),
          })
          .strict(),
      )
      .default([]),
    avoid: z
      .array(
        z
          .object({
            pattern: z.string().min(1),
            use: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
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

const LessonBlockSchema = z.union([BlockMarkdownSchema, BlockExerciseSchema]);

const LessonFieldsSchema = z.object({
  concept: IdSchema,
  version: z.number().int().positive(),
  sources: z
    .array(
      z
        .object({
          source: IdSchema,
          section: z.string().optional(),
        })
        .strict(),
    )
    .optional(),
});

const LegacyLessonSchema = LessonFieldsSchema.extend({
  blocks: z.array(LessonBlockSchema).min(1),
  fast_path: z
    .array(
      z.enum(['objective', 'intuition', 'example', 'check', 'math', 'worked', 'faded', 'summary']),
    )
    .default([]),
}).strict();

const KnowledgePointSchema = z
  .object({
    id: IdSchema,
    title: z.string(),
    explain: z.string(),
    worked: z.string(),
    problems: z.array(IdSchema),
  })
  .strict();

const KnowledgePointLessonSchema = LessonFieldsSchema.extend({
  objective: z.string().min(1),
  where_this_fits: z.string().min(1),
  recap: z
    .array(
      z
        .object({
          concept: IdSchema,
          text: z.string().min(1),
        })
        .strict(),
    )
    .min(1)
    .max(4)
    .optional(),
  knowledge_points: z.array(KnowledgePointSchema).min(1).max(4),
  final: IdSchema,
  summary: z.string().min(1),
}).strict();

export const LessonSchema = z.union([LegacyLessonSchema, KnowledgePointLessonSchema]);

export type LessonBlock = z.infer<typeof LessonBlockSchema>;
export type KnowledgePoint = z.infer<typeof KnowledgePointSchema>;
export type LessonInput = z.infer<typeof LessonSchema>;
export type KnowledgePointLessonInput = z.infer<typeof KnowledgePointLessonSchema>;

import type { LessonPrerequisite } from '@academy/contracts/lessons';

export type { LessonPrerequisite } from '@academy/contracts/lessons';
export type Lesson = Omit<z.infer<typeof LegacyLessonSchema>, 'fast_path'> & {
  fast_path: z.infer<typeof LegacyLessonSchema>['fast_path'];
  knowledge_points?: KnowledgePoint[];
  final?: string;
  where_this_fits?: string;
  recap?: { concept: string; text: string }[];
  summary?: string;
  prerequisites?: LessonPrerequisite[];
};

export function normalizeLesson(
  lesson: KnowledgePointLessonInput,
  isTemplateProblem: (exerciseId: string) => boolean,
): Lesson {
  const blocks: LessonBlock[] = [{ kind: 'objective', md: lesson.objective }];
  for (const point of lesson.knowledge_points) {
    blocks.push({ kind: 'intuition', md: `### ${point.title}\n\n${point.explain}` });
    blocks.push({ kind: 'worked', md: point.worked });
    const fixedProblem = point.problems.slice(1).find((problemId) => !isTemplateProblem(problemId));
    if (fixedProblem) blocks.push({ kind: 'check', exercise: fixedProblem });
  }
  blocks.push({ kind: 'check', exercise: lesson.final });
  blocks.push({ kind: 'summary', md: lesson.summary });
  return {
    concept: lesson.concept,
    version: lesson.version,
    sources: lesson.sources,
    where_this_fits: lesson.where_this_fits,
    recap: lesson.recap,
    summary: lesson.summary,
    final: lesson.final,
    knowledge_points: lesson.knowledge_points,
    blocks,
    fast_path: ['objective', 'summary'],
  };
}

const CommonExerciseSchema = z.object({
  id: IdSchema,
  dimension: DimensionSchema,
  role: ExerciseRoleSchema,
  lesson_only: z.boolean().default(false),
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

const CommonWrongNumericFixedSchema = z
  .object({
    answer: z.number(),
    tolerance: NumericToleranceSchema.optional(),
    category: MistakeCategorySchema,
    feedback: z.string().min(1),
  })
  .strict();

const CommonWrongNumericTemplateSchema = z
  .object({
    answer_expr: z.string().min(1),
    tolerance: NumericToleranceSchema.optional(),
    category: MistakeCategorySchema,
    feedback: z.string().min(1),
  })
  .strict();

const CommonWrongNumericSchema = z.union([
  CommonWrongNumericFixedSchema,
  CommonWrongNumericTemplateSchema,
]);

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

const NumericExerciseBaseSchema = CommonExerciseSchema.extend({
  type: z.literal('numeric'),
  tolerance: NumericToleranceSchema,
});

const NumericExerciseSchema = z.union([
  NumericExerciseBaseSchema.extend({
    answer: z.number(),
    common_wrong: z.array(CommonWrongNumericFixedSchema).optional(),
  }).strict(),
  NumericExerciseBaseSchema.extend({
    answer_expr: z.string().min(1),
    params: z
      .record(
        z.string().min(1),
        z
          .object({
            min: z.number().finite(),
            max: z.number().finite(),
            step: z.number().finite().positive().default(1),
          })
          .strict()
          .refine((range) => range.min <= range.max, {
            message: 'parameter min must be no greater than max',
          }),
      )
      .refine((params) => Object.keys(params).length > 0, {
        message: 'a template must define at least one parameter',
      }),
    constraints: z.array(z.string().min(1)).optional(),
    common_wrong: z.array(CommonWrongNumericSchema).optional(),
  }).strict(),
]);

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
  common_wrong: z.array(CommonWrongNumericFixedSchema).optional(),
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
  solution: z.string().min(1).optional(),
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

export const ProjectSchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1),
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
            inclusive: z.boolean().optional(),
          })
          .strict(),
      )
      .default([]),
    reflection: z.array(IdSchema).default([]),
    follow_up: z.array(z.string()).default([]),
  })
  .strict();

const PaperQuestionSchema = z
  .object({
    id: IdSchema,
    kind: z.enum(['claim', 'method', 'evidence', 'limitations']),
    prompt: z.string().min(1),
  })
  .strict();

const PaperRubricSchema = z
  .object({
    id: IdSchema,
    criterion: z.string().min(1),
    weight: z.number().positive(),
    required: z.boolean().default(false),
  })
  .strict();

export const PaperSchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1),
    authors: z.string().min(1),
    year: z.number().int().positive(),
    est_minutes: z.number().int().min(30).max(180),
    source: z.union([
      z.object({ arxiv: z.string().regex(/^\d{4}\.\d{4,5}v\d+$/) }).strict(),
      z.object({ url: z.string().url() }).strict(),
    ]),
    concepts: z.array(IdSchema).min(1),
    why_this_week: z.string().min(1),
    how_to_read: z.string().min(1),
    questions: z.array(PaperQuestionSchema).length(4),
    summary: z
      .object({
        prompt: z.string().min(1),
        rubric: z.array(PaperRubricSchema).min(3).max(5),
        exemplar: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export const SourceIndexEntrySchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1),
    file: z.string().min(1),
    kind: z.enum(['pdf', 'notes', 'book', 'paper', 'slides', 'other']).optional(),
    added: z.iso.date().optional(),
  })
  .strict();

export const SourceIndexSchema = z
  .object({
    sources: z.array(SourceIndexEntrySchema),
  })
  .strict();

export type Curriculum = z.infer<typeof CurriculumSchema>;
export type Course = z.infer<typeof CourseSchema>;
export type Concept = z.infer<typeof ConceptSchema>;
export type SourceIndexEntry = z.infer<typeof SourceIndexEntrySchema>;
export type SourceIndex = z.infer<typeof SourceIndexSchema>;
export type NotationRegistry = z.infer<typeof NotationSchema>;
export type Exercise = z.infer<typeof ExerciseSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type Paper = z.infer<typeof PaperSchema>;
export type Dimension = z.infer<typeof DimensionSchema>;
export type ExerciseRole = z.infer<typeof ExerciseRoleSchema>;
export type MistakeCategory = z.infer<typeof MistakeCategorySchema>;
