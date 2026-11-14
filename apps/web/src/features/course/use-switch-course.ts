import type { CoursePayload } from '@academy/contracts/course';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { toast } from 'sonner';
import { apiFetch } from '../../api/authenticated-fetch.js';
import { papersQueryOptions } from '../papers/queries.js';
import { todayQueryOptions } from '../sessions/queries.js';
import { courseQueryKeyRoot, learnQueryOptions } from './queries.js';

export function useSwitchCourse(onSuccess?: () => void | Promise<void>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  const mutation = useMutation({
    scope: { id: 'switch-course' },
    mutationFn: async (courseId: string) => {
      const response = await apiFetch('/api/course/active', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ courseId }),
      });
      if (!response.ok) throw new Error('Could not switch courses');
    },
    onError: (_error, failedCourseId) => {
      const location = router.state.location;
      const search = location.search as Record<string, unknown>;
      if (location.pathname === '/course' && search.course === failedCourseId) {
        void navigate({ to: '/course', search: {}, replace: true }).catch(() => {});
      }
      toast.error("Couldn't switch courses");
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

  const switchTo = (courseId: string) => {
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
    mutation.mutate(courseId);
  };

  return { ...mutation, switchTo };
}
