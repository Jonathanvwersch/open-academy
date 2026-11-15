import { expect, test } from 'vitest';
import { buildsOnLineText } from './builds-on-line.js';

test('builds-on line labels completed courses as done', () => {
  expect(
    buildsOnLineText([
      { courseId: 'foundations', title: 'Foundations', topicCount: 2, remaining: 0 },
    ]),
  ).toBe('Builds on Foundations (done).');
});

test('builds-on line reports the remaining partial count', () => {
  expect(
    buildsOnLineText([
      { courseId: 'foundations', title: 'Foundations', topicCount: 3, remaining: 2 },
    ]),
  ).toBe('Builds on Foundations (2 of 3 topics left).');
});

test('builds-on line uses singular wording for one topic', () => {
  expect(
    buildsOnLineText([
      { courseId: 'foundations', title: 'Foundations', topicCount: 1, remaining: 1 },
    ]),
  ).toBe('Builds on Foundations (1 of 1 topic left).');
});

test('builds-on line explains when no other course is needed', () => {
  expect(buildsOnLineText([])).toBe("Doesn't need any other course.");
});

test('builds-on line joins three courses with an Oxford comma', () => {
  expect(
    buildsOnLineText([
      { courseId: 'first', title: 'First', topicCount: 2, remaining: 0 },
      { courseId: 'second', title: 'Second', topicCount: 2, remaining: 1 },
      { courseId: 'third', title: 'Third', topicCount: 1, remaining: 1 },
    ]),
  ).toBe('Builds on First (done), Second (1 of 2 topics left), and Third (1 of 1 topic left).');
});
