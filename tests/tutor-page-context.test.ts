import { expect, test } from 'vitest';
import { loadContent } from '../src/server/content/load.js';
import { buildTutorPageContent, sanitizePageContent } from '../src/server/tutor/page-context.js';

test('page content truncation leaves the required suffix within the size bound', () => {
  const content = sanitizePageContent('x'.repeat(12_001));

  expect(content.endsWith('\n…[truncated]')).toBe(true);
  expect(content.length).toBeLessThanOrEqual(12_000 + '\n…[truncated]'.length);
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
