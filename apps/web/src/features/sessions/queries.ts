import type { SessionPayload, TodayPayload } from '@academy/contracts/sessions';
import { queryOptions } from '@tanstack/react-query';
import { getJson } from '../../api/query-client.js';
export const todayQueryOptions = () =>
  queryOptions({
    queryKey: ['today'] as const,
    queryFn: () => getJson<TodayPayload>('/api/today', 'Could not load Today'),
  });

export const sessionQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['session', id] as const,
    queryFn: () =>
      getJson<SessionPayload>(`/api/sessions/${encodeURIComponent(id)}`, 'Session not found'),
  });
