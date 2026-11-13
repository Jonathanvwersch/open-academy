import type { TutorThreadDetail, TutorThreadSummary } from '@academy/contracts/tutor';
import { queryOptions } from '@tanstack/react-query';
import { getJson } from '../../api/query-client.js';
export const tutorThreadsQueryOptions = () =>
  queryOptions({
    queryKey: ['tutor', 'threads'] as const,
    queryFn: () =>
      getJson<TutorThreadSummary[]>('/api/tutor/threads', 'Tutor conversations unavailable'),
  });

export const tutorThreadQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['tutor', 'thread', id] as const,
    queryFn: () =>
      getJson<TutorThreadDetail>(
        `/api/tutor/threads/${encodeURIComponent(id)}`,
        'Tutor conversation unavailable',
      ),
  });
