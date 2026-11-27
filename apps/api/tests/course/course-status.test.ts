import {
  lowestMasteryState,
  masteryLabel,
  topicIsComplete,
  topicStatus,
} from '@open-academy/engine/graph/course-status';
import { describe, expect, test } from 'vitest';

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

  test('locks incomplete topics when their hard-prerequisite chain is unready', () => {
    expect(
      topicStatus({
        dimensionStates: ['not_assessed'],
        chainReady: false,
      }),
    ).toBe('locked');
    expect(
      topicStatus({
        dimensionStates: ['introduced'],
        chainReady: false,
      }),
    ).toBe('locked');
    expect(
      topicStatus({
        lessonRunStatus: 'in_progress',
        dimensionStates: ['introduced'],
        chainReady: false,
      }),
    ).toBe('locked');
    expect(
      topicStatus({
        dimensionStates: ['assisted'],
        chainReady: false,
      }),
    ).toBe('complete');
    expect(
      topicStatus({
        lessonRunStatus: 'quiz',
        dimensionStates: ['assisted'],
        chainReady: true,
      }),
    ).toBe('quiz');
    expect(
      topicStatus({
        dimensionStates: ['not_assessed'],
        chainReady: true,
      }),
    ).toBe('not_started');
  });
});
