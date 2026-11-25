import { expect, test } from 'vitest';
import { loadContent } from '../../src/content/load.js';
import {
  buildTutorPageContent,
  sanitizePageContent,
} from '../../src/features/tutor/page-context.js';

test('page content truncation leaves the required suffix within the size bound', () => {
  const content = sanitizePageContent('x'.repeat(12_001));

  expect(content.endsWith('\n…[truncated]')).toBe(true);
  expect(content.length).toBeLessThanOrEqual(12_000 + '\n…[truncated]'.length);
});

test('lesson, session, and map tutor context include prerequisite recap facts', async () => {
  const index = await loadContent('tests/fixtures/content');
  const lesson = index.lessonsByConcept.get('derivatives');
  const point = lesson?.knowledge_points?.[0];
  if (!lesson || !point) throw new Error('Missing derivatives fixture');
  lesson.recap = [{ concept: 'vectors', text: 'A vector carries magnitude and direction.' }];

  const expectedRecap = '## Recap\n\nVectors: A vector carries magnitude and direction.';
  const lessonContext = buildTutorPageContent({ page: 'lesson', index, conceptId: 'derivatives' });
  const sessionContext = buildTutorPageContent({
    page: 'session',
    index,
    conceptId: 'derivatives',
    knowledgePointId: point.id,
  });
  const mapContext = buildTutorPageContent({ page: 'map', index, conceptId: 'derivatives' });

  expect(lessonContext).toContain(expectedRecap);
  expect(sessionContext).toContain(expectedRecap);
  expect(mapContext).toContain(expectedRecap);
});

test('Explain-it tutor context separates the current question from completed lesson steps', async () => {
  const index = await loadContent('tests/fixtures/content');
  const lesson = index.lessonsByConcept.get('vectors');
  const secondStep = lesson?.knowledge_points?.[1];
  if (!lesson || !secondStep) throw new Error('Missing vectors lesson steps');

  const content = buildTutorPageContent({
    page: 'session',
    index,
    conceptId: 'vectors',
    lessonStage: 'explain',
    exerciseId: 'vec-explain',
    questionLabel: 'Explain it',
    exercisePrompt: 'Explain how span and rank are related.',
  });

  expect(content).toContain('# Vectors');
  expect(content.indexOf('# Vectors')).toBeLessThan(
    content.indexOf('## Current page: Explain it self-check'),
  );
  expect(content).toContain('## Current page: Explain it self-check');
  expect(content).toContain('Explain how span and rank are related.');
  expect(content).toContain(
    `### Step 2 of ${lesson.knowledge_points?.length ?? 0}: ${secondStep.title}`,
  );
  expect(content).not.toContain('## Current step');
});

test('paper tutor context is ordered, omits empty notes, includes adjacent pages, and preserves selection', async () => {
  const index = await loadContent('tests/fixtures/content');
  const paper = index.papers[0];
  if (!paper) throw new Error('Missing paper fixture');
  const content = buildTutorPageContent({
    page: 'paper',
    index,
    selection: 'selected words',
    paperId: paper.id,
    pageNumber: 3,
    paper: {
      title: paper.title,
      authors: paper.authors,
      year: paper.year,
      whyThisWeek: paper.why_this_week,
      questions: paper.questions,
      notes: { claim: 'A saved note', method: '  ' },
      summary: 'A learner summary',
      feedback: { feedback_md: 'Useful feedback' },
      pages: [
        { page: 3, text: 'Page three' },
        { page: 4, text: 'Page four' },
        { page: 5, text: 'z'.repeat(13_000) },
      ],
    },
  });
  expect(content.indexOf('## Selected passage')).toBeLessThan(content.indexOf('## Paper'));
  expect(content).toContain('## Reading guide questions');
  expect(content).toContain('A saved note');
  expect(content).not.toContain('### method');
  expect(content).toContain('## Page 3 text');
  expect(content).toContain('## Page 4 text');
  expect(content).toContain('selected words');
  expect(content).toContain('…[truncated]');
});
