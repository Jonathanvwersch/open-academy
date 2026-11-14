import { expect, test } from 'vitest';
import { foundationsHeading } from './foundations-heading.js';

test('uses singular wording for one foundation topic', () => {
  expect(foundationsHeading(1)).toBe('Foundations · 1 topic');
});

test('uses plural wording for multiple foundation topics', () => {
  expect(foundationsHeading(2)).toBe('Foundations · 2 topics');
});
