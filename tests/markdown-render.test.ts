import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { loadContent } from '../src/server/content/load.js';
import { instantiateExercise, isTemplate } from '../src/server/content/templates.js';
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
  const content = await loadContent(undefined, { validate: false });
  const samples = [
    ...content.lessons.flatMap((lesson) => [
      ...lesson.blocks.flatMap((block) =>
        'md' in block && block.md ? [{ id: `${lesson.concept} lesson`, md: block.md }] : [],
      ),
      ...(lesson.knowledge_points ?? []).flatMap((point) => [
        { id: `${point.id} title`, md: point.title },
        { id: `${point.id} explain`, md: point.explain },
        { id: `${point.id} worked`, md: point.worked },
      ]),
    ]),
    ...content.exercises.flatMap((exercise) => {
      const prompts = [{ id: exercise.id, md: exercise.prompt }];
      if (!isTemplate(exercise)) return prompts;
      return [
        ...prompts,
        ...Array.from({ length: 5 }, (_, seed) => {
          const instance = instantiateExercise(exercise, seed).exercise;
          if (instance.type !== 'numeric' || !('answer' in instance)) {
            throw new Error(`Template ${exercise.id} did not produce a concrete numeric exercise`);
          }
          return [
            { id: `${exercise.id} seed ${seed} prompt`, md: instance.prompt },
            ...instance.hints.map((md, index) => ({
              id: `${exercise.id} seed ${seed} hint ${index + 1}`,
              md,
            })),
            { id: `${exercise.id} seed ${seed} solution`, md: instance.solution },
            ...(instance.misconceptions ?? []).map((item, index) => ({
              id: `${exercise.id} seed ${seed} misconception ${index + 1}`,
              md: item.feedback,
            })),
            ...(instance.common_wrong ?? []).map((item, index) => ({
              id: `${exercise.id} seed ${seed} common wrong ${index + 1}`,
              md: item.feedback,
            })),
          ];
        }).flat(),
      ];
    }),
  ];

  for (const sample of samples) {
    const html = renderToStaticMarkup(createElement(Markdown, null, sample.md));
    expect(html, sample.id).not.toContain('katex-error');
    expect(html, sample.id).not.toContain('|---|');
  }
}, 20_000); // Renders all lesson Markdown, exercise prompts, and five samples per template.
