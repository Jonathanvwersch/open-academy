import type { CoursePayload } from '@academy/contracts/course';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { apiFetch } from '../../api/authenticated-fetch.js';
import { papersQueryOptions } from '../papers/queries.js';
import { todayQueryOptions } from '../sessions/queries.js';
import { courseQueryKeyRoot, learnQueryOptions } from './queries.js';

export function useSwitchCourse(onSuccess?: () => void | Promise<void>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (courseId: string) => {
      const response = await apiFetch('/api/course/active', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ courseId }),
      });
      if (!response.ok) throw new Error('Could not switch courses');
    },
    onMutate: (courseId) => {
      const previous = queryClient.getQueriesData<CoursePayload>({
        queryKey: courseQueryKeyRoot,
      });
      queryClient.setQueriesData<CoursePayload>({ queryKey: courseQueryKeyRoot }, (current) =>
        current
          ? {
              ...current,
              courses: current.courses.map((course) => ({
                ...course,
                active: course.id === courseId,
              })),
            }
          : current,
      );
      void navigate({ to: '/course', search: { course: courseId } }).catch(() => {});
      return { previous };
    },
    onError: (_error, _courseId, context) => {
      for (const [queryKey, data] of context?.previous ?? []) {
        if (data === undefined) {
          queryClient.removeQueries({ queryKey, exact: true });
        } else {
          queryClient.setQueryData(queryKey, data);
        }
      }
    },
    onSuccess: async () => {
      await onSuccess?.();
    },
    onSettled: () => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: courseQueryKeyRoot }),
        queryClient.invalidateQueries({ queryKey: learnQueryOptions().queryKey }),
        queryClient.invalidateQueries({ queryKey: todayQueryOptions().queryKey }),
        queryClient.invalidateQueries({ queryKey: papersQueryOptions().queryKey }),
      ]);
    },
  });
}
