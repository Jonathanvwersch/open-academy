import type { ContentIndex, IndexedLesson } from '@academy/aesop/course/types';
import type { TutorLessonStage } from '@academy/contracts/tutor';

export interface CourseOutlineUnit {
  unit: number;
  title: string;
  intro?: string;
  topics: Array<{ title: string; status: string }>;
}

export interface PaperTutorContext {
  title: string;
  authors: string;
  year: number;
  whyThisWeek: string;
  questions: Array<{ kind: string; prompt: string }>;
  notes: Record<string, string>;
  summary?: string | null;
  feedback?: unknown;
  pages: Array<{ page: number; text: string }>;
}

const PAGE_CONTENT_LIMIT = 12_000;
const TRUNCATION_SUFFIX = '\n…[truncated]';

export function sanitizePageContent(content: string): string {
  const sanitized = content.replace(/```[ \t]*svg\b[^\n]*\r?\n[\s\S]*?```/gi, '[diagram]');
  return sanitized.length > PAGE_CONTENT_LIMIT
    ? `${sanitized.slice(0, PAGE_CONTENT_LIMIT)}${TRUNCATION_SUFFIX}`
    : sanitized;
}

function summaryFor(lesson: IndexedLesson): string {
  return lesson.blocks
    .filter((block) => block.kind === 'summary')
    .map((block) => block.md)
    .join('\n\n');
}

function titleFor(index: ContentIndex, conceptId: string | null | undefined): string {
  return conceptId ? (index.conceptsById.get(conceptId)?.title ?? conceptId) : 'General';
}

function recapFor(index: ContentIndex, lesson: IndexedLesson): string {
  return (lesson.recap ?? [])
    .map(({ concept, text }) => `${titleFor(index, concept)}: ${text}`)
    .join('\n');
}

function section(title: string, content: string): string {
  return content ? `## ${title}\n\n${content}` : '';
}

export function buildTutorPageContent(input: {
  page?: 'session' | 'lesson' | 'course' | 'map' | 'paper';
  index: ContentIndex;
  conceptId?: string | null;
  knowledgePointId?: string;
  lessonStage?: TutorLessonStage;
  exerciseId?: string;
  exercisePrompt?: string;
  questionLabel?: string;
  courseUnits?: CourseOutlineUnit[];
  paper?: PaperTutorContext;
  paperId?: string;
  pageNumber?: number;
  selection?: string;
}): string {
  const { page, index, conceptId, knowledgePointId, courseUnits } = input;
  if (!page) return '';

  if (page === 'paper') {
    const paper = input.paper;
    if (!paper) return '';
    const notes = Object.entries(paper.notes)
      .filter(([, text]) => text.trim())
      .map(([id, text]) => `### ${id}\n\n${text}`)
      .join('\n\n');
    const content = [
      input.selection ? `## Selected passage\n\n${input.selection}` : '',
      `## Paper\n\n${paper.title}\n\n${paper.authors} · ${paper.year}\n\n${paper.whyThisWeek}`,
      `## Reading guide questions\n\n${paper.questions.map((question) => `- **${question.kind}:** ${question.prompt}`).join('\n')}`,
      section("Learner's notes", notes),
      paper.summary
        ? `## Learner's summary\n\n${paper.summary}${paper.feedback ? `\n\n## Summary feedback\n\n${JSON.stringify(paper.feedback)}` : ''}`
        : '',
      ...paper.pages.map(({ page: number, text }) => `## Page ${number} text\n\n${text}`),
    ]
      .filter(Boolean)
      .join('\n\n');
    return sanitizePageContent(content);
  }

  const concept = conceptId ? index.conceptsById.get(conceptId) : undefined;
  const lesson = conceptId ? index.lessonsByConcept.get(conceptId) : undefined;
  const title = titleFor(index, conceptId);

  if (page === 'course') {
    return sanitizePageContent(
      (courseUnits ?? [])
        .flatMap((unit) => [
          `## Unit ${unit.unit} · ${unit.title}`,
          ...(unit.intro ? [unit.intro] : []),
          ...unit.topics.map((topic) => `- ${topic.title} — ${topic.status}`),
        ])
        .join('\n'),
    );
  }

  if (page === 'map') {
    if (!concept) return '';
    const objectives = concept.objectives.map((objective) => `- ${objective.text}`).join('\n');
    const prerequisites = concept.prereqs
      .map(
        (prerequisite) => `- ${index.conceptsById.get(prerequisite.id)?.title ?? prerequisite.id}`,
      )
      .join('\n');
    const sections = [
      `# ${concept.title}`,
      section('Objectives', objectives),
      section('Prerequisites', prerequisites),
      `Lesson available: ${lesson ? 'yes' : 'no'}`,
      ...(lesson
        ? [
            section('Recap', recapFor(index, lesson)),
            section("What you're learning", lesson.where_this_fits ?? ''),
            section('Summary', summaryFor(lesson)),
          ]
        : []),
    ];
    return sanitizePageContent(sections.filter(Boolean).join('\n\n'));
  }

  if (!lesson) return '';

  if (page === 'session') {
    const points = lesson.knowledge_points ?? [];
    const pointIndex = knowledgePointId
      ? points.findIndex((point) => point.id === knowledgePointId)
      : -1;
    const recap = section('Recap', recapFor(index, lesson));
    const whereThisFits = section("What you're learning", lesson.where_this_fits ?? '');
    if (pointIndex < 0) {
      if (input.lessonStage === 'explain' || input.lessonStage === 'quiz') {
        const stageTitle = input.lessonStage === 'explain' ? 'Explain it self-check' : 'Quiz';
        const question =
          input.exerciseId && input.exercisePrompt?.trim()
            ? `## ${input.questionLabel ?? stageTitle} prompt\n\n${input.exercisePrompt.trim()}`
            : '';
        const completedSteps = `## Lesson steps (completed; not on this page)\n\n${points
          .map(
            (point, index) =>
              `### Step ${index + 1} of ${points.length}: ${point.title}\n\n${point.tldr ?? ''}`,
          )
          .join('\n\n')}`;
        return sanitizePageContent(
          [
            `# ${title}`,
            `## Current page: ${stageTitle}`,
            question,
            completedSteps,
            section('Lesson summary (not on this page)', summaryFor(lesson)),
          ]
            .filter(Boolean)
            .join('\n\n'),
        );
      }
      return sanitizePageContent(
        [`# ${title}`, recap, whereThisFits, section('Summary', summaryFor(lesson))]
          .filter(Boolean)
          .join('\n\n'),
      );
    }

    const point = points[pointIndex];
    if (!point) return '';
    return sanitizePageContent(
      [
        `# ${title}`,
        recap,
        whereThisFits,
        `## Current step (${pointIndex + 1} of ${points.length}): ${point.title}`,
        point.explain,
        section('Worked example', point.worked),
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
  }

  const points = lesson.knowledge_points ?? [];
  if (points.length > 0) {
    return sanitizePageContent(
      [
        `# ${title}`,
        section('Recap', recapFor(index, lesson)),
        section("What you're learning", lesson.where_this_fits ?? ''),
        section('Summary', summaryFor(lesson)),
        ...points.flatMap((point) => [
          `## ${point.title}`,
          point.explain,
          section('Worked example', point.worked),
        ]),
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
  }

  return sanitizePageContent(
    [
      `# ${title}`,
      ...lesson.blocks.filter((block) => block.kind !== 'check').map((block) => block.md),
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
}
