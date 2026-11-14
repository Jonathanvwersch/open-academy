import { beforeAll, expect, test } from 'vitest';
import { loadContent } from '../../src/content/load.js';
import type { ContentIndex } from '../../src/content/types.js';
import { suggestedNextCourses } from '../../src/features/course/service.js';

let content: ContentIndex;

beforeAll(async () => {
  content = await loadContent();
});

test('suggested next courses rank hard-prerequisite links to the completed course', () => {
  const statuses = new Map<string, 'not_started' | 'active' | 'paused' | 'completed'>(
    content.courses.map((course) => [course.id, 'not_started']),
  );
  statuses.set('ml-foundations', 'completed');

  const suggestions = suggestedNextCourses(content, 'ml-foundations', statuses);

  expect(suggestions[0]).toEqual({
    id: 'deep-learning',
    title: 'Deep Learning',
    reason: 'Builds on Machine Learning Foundations',
  });
  expect(suggestions.length).toBeLessThanOrEqual(2);
});
