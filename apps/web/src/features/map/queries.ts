import type { StudyMapPayload } from '@academy/contracts/course';
import { queryOptions } from '@tanstack/react-query';
import { getJson } from '../../api/query-client.js';

export const studyMapQueryOptions = () =>
  queryOptions({
    queryKey: ['study-map'] as const,
    queryFn: () => getJson<StudyMapPayload>('/api/study-map', 'Could not load Map'),
  });
