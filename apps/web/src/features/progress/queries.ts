import type { ProgressPayload } from '@academy/contracts/progress';
import { queryOptions } from '@tanstack/react-query';
import { getJson } from '../../api/query-client.js';
export const progressQueryOptions = () =>
  queryOptions({
    queryKey: ['progress'] as const,
    queryFn: () => getJson<ProgressPayload>('/api/progress', 'Progress unavailable'),
  });
