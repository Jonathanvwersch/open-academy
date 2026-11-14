import type { TodayPayload } from '@academy/contracts/sessions';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { apiFetch } from '../../api/authenticated-fetch.js';
import { todayQueryOptions } from './queries.js';

export function useStartSession(
  sessionKind: TodayPayload['sessionKind'],
  onStarted?: (session: { id: string }) => void | Promise<void>,
) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async () => {
      const response = await apiFetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: sessionKind }),
      });
      if (!response.ok) throw new Error('Could not start session');
      return response.json() as Promise<{ id: string }>;
    },
    onSuccess: async ({ id }) => {
      if (onStarted) {
        await onStarted({ id });
        return;
      }
      queryClient.setQueryData(todayQueryOptions().queryKey, (current) =>
        current ? { ...current, activeSessionId: id } : current,
      );
      await navigate({ to: '/session/$id', params: { id } });
    },
  });
}
