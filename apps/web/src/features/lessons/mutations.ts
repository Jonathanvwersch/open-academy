import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiFetch } from '../../api/authenticated-fetch.js';
import { invalidateCourseStudyQueries } from '../course/queries.js';

export function useRestartTopic() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ conceptId }: { conceptId: string; topicTitle: string }) => {
      const response = await apiFetch(`/api/concepts/${encodeURIComponent(conceptId)}/restart`, {
        method: 'POST',
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
        throw new Error(
          typeof body?.error === 'string' ? body.error : 'Could not restart this topic',
        );
      }
    },
    onSuccess: (_data, { topicTitle }) => {
      toast(`${topicTitle} restarted`);
      void invalidateCourseStudyQueries(queryClient);
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });
}
