import type { AuthPayload } from '@open-academy/engine/api/auth';
import { queryOptions } from '@tanstack/react-query';
import { getJson } from '../../api/query-client.js';
export const authQueryOptions = () =>
  queryOptions({
    queryKey: ['auth', 'me'] as const,
    queryFn: () => getJson<AuthPayload>('/api/auth/me', 'Could not check authentication'),
    staleTime: Infinity,
  });
