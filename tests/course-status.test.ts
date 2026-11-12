import { describe, expect, test } from 'vitest';
import {
  lowestMasteryState,
  masteryLabel,
  topicIsComplete,
  topicStatus,
} from '../src/server/learning/course-status.js';

describe('course mastery and status', () => {
  test('maps mastery labels and uses the lowest dimension state', () => {
    expect(masteryLabel('not_assessed')).toBe('Not started');
    expect(masteryLabel('introduced')).toBe('Attempted');
    expect(masteryLabel('assisted')).toBe('Familiar');
    expect(masteryLabel('independent')).toBe('Proficient');
    expect(masteryLabel('retained')).toBe('Mastered');
    expect(lowestMasteryState(['retained', 'assisted', 'independent'])).toBe('assisted');
    expect(lowestMasteryState([])).toBe('not_assessed');
  });

  test('a completed lesson or assisted mastery across all dimensions completes a topic', () => {
    expect(topicIsComplete('completed', ['not_assessed'])).toBe(true);
    expect(topicIsComplete(undefined, ['assisted', 'independent'])).toBe(true);
    expect(topicIsComplete(undefined, ['assisted', 'introduced'])).toBe(false);
    expect(topicIsComplete('quiz', ['assisted', 'independent'])).toBe(false);
    expect(topicIsComplete('in_progress', ['assisted', 'independent'])).toBe(false);
  });

  test('locks only unstarted topics with an incomplete hard prerequisite', () => {
    expect(
      topicStatus({
        dimensionStates: ['not_assessed'],
        prerequisites: [{ strength: 'hard', done: false }],
      }),
    ).toBe('locked');
    expect(
      topicStatus({
        dimensionStates: ['introduced'],
        prerequisites: [{ strength: 'hard', done: false }],
      }),
    ).toBe('in_progress');
    expect(
      topicStatus({
        dimensionStates: ['not_assessed'],
        prerequisites: [{ strength: 'soft', done: false }],
      }),
    ).toBe('not_started');
    expect(
      topicStatus({
        dimensionStates: ['assisted'],
        prerequisites: [{ strength: 'hard', done: false }],
      }),
    ).toBe('complete');
    expect(
      topicStatus({
        lessonRunStatus: 'quiz',
        dimensionStates: ['assisted'],
        prerequisites: [{ strength: 'hard', done: false }],
      }),
    ).toBe('quiz');
  });
});
