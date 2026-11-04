import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { loadContent } from '../src/server/content/load.js';
import { Markdown } from '../src/web/components';

test('lesson Markdown renders GFM tables', () => {
  const html = renderToStaticMarkup(
    createElement(Markdown, null, '| a | b |\n|---|---|\n| 1 | $x$ |'),
  );
  expect(html).toContain('<table>');
  expect(html).toContain('<td>1</td>');
  expect(html).toContain('katex');
});

test('all authored lesson Markdown and exercise prompts render without errors', async () => {
  const content = await loadContent();
  const samples = [
    ...content.lessons.flatMap((lesson) =>
      lesson.blocks.flatMap((block) =>
        'md' in block && block.md ? [{ id: `${lesson.concept} lesson`, md: block.md }] : [],
      ),
    ),
    ...content.exercises.map((exercise) => ({
      id: exercise.id,
      md: exercise.prompt,
    })),
  ];

  for (const sample of samples) {
    const html = renderToStaticMarkup(createElement(Markdown, null, sample.md));
    expect(html, sample.id).not.toContain('katex-error');
    expect(html, sample.id).not.toContain('|---|');
  }
});
