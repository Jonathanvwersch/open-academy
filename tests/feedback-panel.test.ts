import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { FeedbackPanel } from '../src/web/components.js';

function renderFeedback(result: Record<string, unknown>, xp?: number) {
  return renderToStaticMarkup(
    createElement(FeedbackPanel, { result, ...(xp === undefined ? {} : { xp }) }),
  );
}

test('generic correct feedback does not repeat the XP title and shows the solution', () => {
  const html = renderFeedback(
    {
      correct: 1,
      feedback: 'Correct.',
      solution: 'The score is 0.5, so the output is 1.',
    },
    10,
  );

  expect(html).toContain('Correct · +10 XP');
  expect(html.match(/Correct/g) ?? []).toHaveLength(1);
  expect(html).not.toContain('Correct.');
  expect(html).toContain('The score is 0.5, so the output is 1.');
});

test('generic grader feedback matching other headings is case-insensitive', () => {
  const cases = [
    { correct: 0, feedback: 'NOT QUITE.', title: 'Not quite' },
    { correct: 0.5, feedback: 'PARTLY CORRECT.', title: 'Partly correct' },
    { correct: 0.5, followUp: true, feedback: 'aLmOsT.', title: 'Almost' },
  ];

  for (const { title, ...result } of cases) {
    const html = renderFeedback(result);
    expect(html.toLowerCase().split(title.toLowerCase())).toHaveLength(2);
    expect(html).not.toContain(result.feedback);
  }
});

test('correct answers with specific option feedback keep that feedback instead of the solution', () => {
  const html = renderFeedback({
    correct: 1,
    feedback: 'That option is right because its score is positive.',
    solution: 'The full calculation is 2 − 1 − 0.5 = 0.5.',
  });

  expect(html).toContain('That option is right because its score is positive.');
  expect(html).not.toContain('The full calculation is 2');
});

test('written answers keep the model answer instead of showing the numeric solution', () => {
  const html = renderFeedback({
    correct: 1,
    feedback: 'Correct.',
    exemplar: 'A vector has length and direction.',
    solution: 'The extra calculation belongs to another answer surface.',
  });

  expect(html).toContain('Model answer');
  expect(html).toContain('A vector has length and direction.');
  expect(html).not.toContain('The extra calculation belongs to another answer surface.');
});

test('wrong answers keep feedback, answer lines, and solution', () => {
  const html = renderFeedback({
    correct: 0,
    feedback: 'Check the sign of the bias.',
    yourAnswer: '0',
    correctAnswer: '1',
    solution: 'The score is 0.5, so the output is 1.',
  });

  expect(html).toContain('Not quite');
  expect(html).toContain('Check the sign of the bias.');
  expect(html).toContain('Your answer:');
  expect(html).toContain('Correct answer:');
  expect(html).toContain('Solution');
  expect(html).toContain('The score is 0.5, so the output is 1.');
});
