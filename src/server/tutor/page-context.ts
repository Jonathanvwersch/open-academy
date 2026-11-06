import type { ContentIndex, IndexedLesson } from '../content/types.js';

export interface CourseOutlineWeek {
  week: number;
  title: string;
  intro?: string;
  topics: Array<{ title: string; status: string }>;
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

function section(title: string, content: string): string {
  return content ? `## ${title}\n\n${content}` : '';
}

export function buildTutorPageContent(input: {
  page?: 'session' | 'lesson' | 'course' | 'map';
  index: ContentIndex;
  conceptId?: string | null;
  knowledgePointId?: string;
  courseWeeks?: CourseOutlineWeek[];
}): string {
  const { page, index, conceptId, knowledgePointId, courseWeeks } = input;
  if (!page) return '';

  const concept = conceptId ? index.conceptsById.get(conceptId) : undefined;
  const lesson = conceptId ? index.lessonsByConcept.get(conceptId) : undefined;
  const title = titleFor(index, conceptId);

  if (page === 'course') {
    return sanitizePageContent(
      (courseWeeks ?? [])
        .flatMap((week) => [
          `## Week ${week.week} · ${week.title}`,
          ...(week.intro ? [week.intro] : []),
          ...week.topics.map((topic) => `- ${topic.title} — ${topic.status}`),
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
            section('Where this fits', lesson.where_this_fits ?? ''),
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
    const whereThisFits = section('Where this fits', lesson.where_this_fits ?? '');
    if (pointIndex < 0) {
      return sanitizePageContent(
        [`# ${title}`, whereThisFits, section('Summary', summaryFor(lesson))]
          .filter(Boolean)
          .join('\n\n'),
      );
    }

    const point = points[pointIndex];
    if (!point) return '';
    return sanitizePageContent(
      [
        `# ${title}`,
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
        section('Where this fits', lesson.where_this_fits ?? ''),
        ...points.flatMap((point) => [
          `## ${point.title}`,
          point.explain,
          section('Worked example', point.worked),
        ]),
        section('Summary', summaryFor(lesson)),
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
