import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { FeedbackPanel, isFinalRetryResult } from './feedback-panel.js';

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

test('only an incorrect, locked retry is a final retry result', () => {
  expect(isFinalRetryResult({ attemptNo: 2, retryAllowed: false, correct: 0.5 })).toBe(true);
  expect(isFinalRetryResult({ attemptNo: 1, retryAllowed: false, correct: 0.5 })).toBe(false);
  expect(isFinalRetryResult({ attemptNo: 2, retryAllowed: false, correct: 1 })).toBe(false);
  expect(isFinalRetryResult({ attemptNo: 2, retryAllowed: true, correct: 0.5 })).toBe(false);
  expect(
    isFinalRetryResult({
      attemptNo: 2,
      retryAllowed: false,
      correct: 0.5,
      status: 'invalid',
    }),
  ).toBe(false);
});

test('generic grader feedback matching other headings is case-insensitive', () => {
  const cases = [
    { correct: 0, feedback: 'NOT QUITE.', title: 'Not quite' },
    { correct: 0.5, feedback: 'PARTLY CORRECT.', title: 'Partly correct' },
    { correct: 0.5, followUp: true, feedback: 'aLmOsT.', title: 'Almost' },
  ];

  for (const { title, ...result } of cases) {
    const html = renderFeedback(result);
    expect(html.toLowerCase().split(`>${title.toLowerCase()}<`)).toHaveLength(2);
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

test('strips a repeated Not quite title from wrong-answer feedback', () => {
  const html = renderFeedback({
    correct: 0,
    feedback: 'Not quite. Review the quantities and try again.',
  });

  expect(html.match(/Not quite/g) ?? []).toHaveLength(1);
  expect(html).toContain('Review the quantities and try again.');
});

test('strips a repeated Correct title and capitalizes the remaining feedback', () => {
  const html = renderFeedback({ correct: 1, feedback: 'Correct! Nice work.' });

  expect(html.match(/Correct/g) ?? []).toHaveLength(1);
  expect(html).toContain('Nice work.');
});

test('strips a repeated Partly correct title and capitalizes the remaining feedback', () => {
  const html = renderFeedback({
    correct: 0.5,
    feedback: 'Partly correct — you missed the bias.',
  });

  expect(html).toContain('You missed the bias.');
  expect(html).not.toContain('you missed the bias.');
});

test('hides feedback that contains only the repeated title', () => {
  const html = renderFeedback({ correct: 0, feedback: 'Not quite.' });

  expect(html.match(/Not quite/g) ?? []).toHaveLength(1);
  expect(html).not.toContain('data-slot="alert-description"');
});

test('does not strip a title word in the middle of feedback', () => {
  const html = renderFeedback({ correct: 0, feedback: 'This is not quite the MAE.' });

  expect(html).toContain('This is not quite the MAE.');
});

test('does not strip a title word that starts a sentence without punctuation', () => {
  const html = renderFeedback({
    correct: 1,
    feedback:
      'Correct arithmetic cannot remove disagreement between a subset and the whole dataset.',
  });

  expect(html).toContain('Correct arithmetic cannot remove disagreement');
});

test('Almost feedback with a partial rubric item tells the learner what to add', () => {
  const html = renderFeedback({
    correct: 0.5,
    followUp: true,
    rubric: [{ id: 'loss', criterion: 'Explain the loss', judgement: 'partial' }],
  });

  expect(
    html.match(/Add the points marked ½ or ✗ to your answer above, then press /g) ?? [],
  ).toHaveLength(1);
  expect(html).toContain('<strong>Submit again</strong>');
  expect(html).toContain('You have one more try before the model answer is shown.');
});

test('unmet optional criteria are neutral and do not count as an Almost shortfall', () => {
  const html = renderFeedback({
    correct: 1,
    feedback: 'Correct.',
    rubric: [
      { id: 'required', criterion: 'Names the learning rate', judgement: 'met', required: true },
      { id: 'optional', criterion: 'Mentions curvature', judgement: 'missing', required: false },
    ],
  });

  expect(html).toContain('Correct');
  expect(html).toContain('Also worth mentioning');
  expect(html).toContain('Mentions curvature');
  expect(html).not.toContain('Add the points marked ½ or ✗');
  expect(html).not.toContain('½ Mentions curvature');
  expect(html).not.toContain('✗ Mentions curvature');
});

test('a missing criterion in an optional-only rubric counts as an Almost shortfall', () => {
  const html = renderFeedback({
    correct: 0.5,
    followUp: true,
    rubric: [
      {
        id: 'optional',
        criterion: 'Mentions curvature',
        judgement: 'missing',
        required: true,
      },
    ],
  });

  expect(html).toContain('✗');
  expect(html).toContain('Mentions curvature');
  expect(html).toContain('Add the points marked ½ or ✗');
  expect(html).not.toContain('Also worth mentioning');
});

test('old rubric feedback without required flags keeps the existing shortfall marker', () => {
  const html = renderFeedback({
    correct: 0.5,
    followUp: true,
    rubric: [{ id: 'old', criterion: 'Explain the loss', judgement: 'missing' }],
  });

  expect(html).toContain('✗');
  expect(html).toContain('Add the points marked ½ or ✗');
});

test('Almost feedback without a rubric gives generic next-step guidance', () => {
  const html = renderFeedback({ correct: 0.5, followUp: true });

  expect(html.replaceAll('&#x27;', "'")).toContain(
    "Add what's missing to your answer above, then press <strong>Submit again</strong>.",
  );
  expect(html).toContain('You have one more try before the model answer is shown.');
});

test('non-follow-up partly correct and correct results omit Almost guidance', () => {
  const partlyCorrect = renderFeedback({ correct: 0.5 });
  const correct = renderFeedback({ correct: 1 });

  expect(partlyCorrect).not.toContain('almost-next-step');
  expect(correct).not.toContain('almost-next-step');
});
