import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { Markdown } from '../src/web/components';

test('lesson Markdown renders GFM tables', () => {
  const html = renderToStaticMarkup(
    createElement(Markdown, null, '| a | b |\n|---|---|\n| 1 | $x$ |'),
  );
  expect(html).toContain('<table>');
  expect(html).toContain('<td>1</td>');
  expect(html).toContain('katex');
});
