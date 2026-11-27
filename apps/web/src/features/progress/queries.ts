import type { ProgressPayload } from '@open-academy/engine/api';
import { queryOptions } from '@tanstack/react-query';
import { getJson } from '../../api/query-client.js';
export const progressQueryOptions = () =>
  queryOptions({
    queryKey: ['progress'] as const,
    queryFn: () => getJson<ProgressPayload>('/api/progress', 'Progress unavailable'),
  });
