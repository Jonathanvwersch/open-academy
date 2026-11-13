import type { CoursePayload, LearnPayload } from '@academy/contracts/course';
import { queryOptions } from '@tanstack/react-query';
import { getJson } from '../../api/query-client.js';
export const learnQueryOptions = () =>
  queryOptions({
    queryKey: ['learn'] as const,
    queryFn: () => getJson<LearnPayload>('/api/learn', 'Could not load Learn'),
  });

export const courseQueryOptions = () =>
  queryOptions({
    queryKey: ['course'] as const,
    queryFn: () => getJson<CoursePayload>('/api/course', 'Could not load Course'),
  });

export const conceptQueryOptions = (conceptId: string) =>
  queryOptions({
    queryKey: ['concept', conceptId] as const,
    queryFn: () =>
      getJson<Record<string, unknown>>(
        `/api/concepts/${encodeURIComponent(conceptId)}`,
        'Concept unavailable',
      ),
  });
