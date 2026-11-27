import type { ActiveSessionPayload, SessionPayload, TodayPayload } from '@open-academy/engine/api';
import { queryOptions } from '@tanstack/react-query';
import { getJson } from '../../api/query-client.js';

export function chosenActivity(
  session: Pick<SessionPayload, 'activities' | 'current'>,
  requestedId?: string,
) {
  const requested = session.activities.find((activity) => activity.id === requestedId);
  return requested && session.current.openableIds.includes(requested.id)
    ? requested
    : session.activities.find((activity) => activity.id === session.current.activityId);
}

export const activeSessionQueryOptions = () =>
  queryOptions({
    queryKey: ['session', 'active'] as const,
    queryFn: () =>
      getJson<ActiveSessionPayload | null>('/api/sessions/active', 'Could not load active session'),
  });

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
