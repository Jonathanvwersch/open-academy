import type { CoursePayload, LearnPayload } from '@academy/contracts/course';
import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { getJson } from '../../api/query-client.js';
import { reviewsQueryOptions } from '../reviews/queries.js';

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

export function invalidateSidebarQueries(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: courseQueryOptions().queryKey }),
    queryClient.invalidateQueries({ queryKey: reviewsQueryOptions().queryKey }),
  ]);
}

export const conceptQueryOptions = (conceptId: string) =>
  queryOptions({
    queryKey: ['concept', conceptId] as const,
    queryFn: () =>
      getJson<Record<string, unknown>>(
        `/api/concepts/${encodeURIComponent(conceptId)}`,
        'Concept unavailable',
      ),
  });
