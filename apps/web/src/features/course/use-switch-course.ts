import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../api/authenticated-fetch.js';
import { papersQueryOptions } from '../papers/queries.js';
import { todayQueryOptions } from '../sessions/queries.js';
import { courseQueryOptions, learnQueryOptions } from './queries.js';

export function useSwitchCourse(onSuccess?: () => void | Promise<void>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (courseId: string) => {
      const response = await apiFetch('/api/course/active', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ courseId }),
      });
      if (!response.ok) throw new Error('Could not switch courses');
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: courseQueryOptions().queryKey }),
        queryClient.invalidateQueries({ queryKey: learnQueryOptions().queryKey }),
        queryClient.invalidateQueries({ queryKey: todayQueryOptions().queryKey }),
        queryClient.invalidateQueries({ queryKey: papersQueryOptions().queryKey }),
      ]);
      await onSuccess?.();
    },
  });
}
