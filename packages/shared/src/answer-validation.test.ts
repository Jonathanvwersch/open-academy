import { emptyAnswerMessage } from '@academy/shared/answer-validation';
import { expect, test } from 'vitest';

test.each([
  ['mc', '', 'Choose an answer first.'],
  ['mc', [], 'Choose an answer first.'],
  ['numeric', ' \t ', 'Write an answer first.'],
  ['code_read', '', 'Write an answer first.'],
  ['code_complete', '  ', 'Write an answer first.'],
  ['text', '\n', 'Write an answer first.'],
  ['explain', { text: '  ' }, 'Write an answer first.'],
  ['debug', { line: 0, fixId: '' }, 'Write an answer first.'],
])('rejects an empty %s answer', (type, answer, message) => {
  expect(emptyAnswerMessage(type, answer)).toBe(message);
});

test.each([
  ['mc', 'option-a'],
  ['numeric', 0],
  ['code_read', 0],
  ['code_complete', 'return x'],
  ['text', 'answer'],
  ['explain', { text: 'reason' }],
  ['debug', { line: 1, fixId: 'fix-a' }],
])('accepts a nonempty %s answer', (type, answer) => {
  expect(emptyAnswerMessage(type, answer)).toBeNull();
});
