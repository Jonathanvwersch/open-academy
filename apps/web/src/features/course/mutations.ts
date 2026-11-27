import type { CourseCatalogPayload, CourseDetailPayload } from '@academy/aesop/api/course';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiFetch } from '../../api/authenticated-fetch.js';
import {
  courseDetailQueryOptions,
  coursesQueryKeyRoot,
  invalidateCourseStudyQueries,
} from './queries.js';

type EnrollmentStatus = 'active' | 'paused';

function updateCatalogStatus(
  catalog: CourseCatalogPayload | undefined,
  courseId: string,
  status: EnrollmentStatus,
) {
  if (!catalog) return catalog;
  return {
    ...catalog,
    subjects: catalog.subjects.map((subject) => ({
      ...subject,
      courses: subject.courses.map((course) =>
        course.id === courseId ? { ...course, status } : course,
      ),
    })),
  };
}

function activeCourseCount(catalog: CourseCatalogPayload | undefined) {
  return (
    catalog?.subjects.reduce(
      (total, subject) =>
        total + subject.courses.filter((course) => course.status === 'active').length,
      0,
    ) ?? 0
  );
}

function useOptimisticCourseStatus(
  courseId: string,
  courseTitle: string,
  request: (status: EnrollmentStatus) => Promise<void>,
) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: request,
    onMutate: async (status: EnrollmentStatus) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: coursesQueryKeyRoot }),
        queryClient.cancelQueries({ queryKey: courseDetailQueryOptions(courseId).queryKey }),
      ]);
      const previousCatalog = queryClient.getQueryData<CourseCatalogPayload>(coursesQueryKeyRoot);
      const previousDetail = queryClient.getQueryData<CourseDetailPayload>(
        courseDetailQueryOptions(courseId).queryKey,
      );
      const previousActiveCount = activeCourseCount(previousCatalog);
      queryClient.setQueryData(
        coursesQueryKeyRoot,
        updateCatalogStatus(previousCatalog, courseId, status),
      );
      queryClient.setQueryData<CourseDetailPayload>(
        courseDetailQueryOptions(courseId).queryKey,
        (current) => (current ? { ...current, status } : current),
      );
      return {
        previousCatalog,
        previousDetail,
        activeCountAfter:
          previousActiveCount +
          (status === 'active' &&
          previousCatalog?.subjects.some((subject) =>
            subject.courses.some((course) => course.id === courseId && course.status !== 'active'),
          )
            ? 1
            : 0),
      };
    },
    onError: (_error, _status, context) => {
      if (context?.previousCatalog) {
        queryClient.setQueryData(coursesQueryKeyRoot, context.previousCatalog);
      }
      if (context?.previousDetail) {
        queryClient.setQueryData(
          courseDetailQueryOptions(courseId).queryKey,
          context.previousDetail,
        );
      }
      toast.error(`Couldn't update ${courseTitle}`);
    },
    onSuccess: (_data, status, context) => {
      if (status === 'paused') {
        toast('Removed from My courses', {
          action: {
            label: 'Undo',
            onClick: () => mutation.mutate('active'),
          },
        });
      } else if (context && context.activeCountAfter >= 4) {
        toast('Added. Each course will move more slowly with 4 or more.');
      }
    },
    onSettled: () => {
      void invalidateCourseStudyQueries(queryClient);
    },
  });

  return mutation;
}

export function useCourseEnrollment(courseId: string, courseTitle: string) {
  return useOptimisticCourseStatus(courseId, courseTitle, async (status) => {
    const response = await apiFetch(`/api/courses/${encodeURIComponent(courseId)}/enrollment`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (!response.ok) throw new Error('Could not update this course');
  });
}

export function useStartCourse(courseId: string, courseTitle: string) {
  return useOptimisticCourseStatus(courseId, courseTitle, async () => {
    const response = await apiFetch(`/api/courses/${encodeURIComponent(courseId)}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'beginning' }),
    });
    if (!response.ok) throw new Error('Could not start this course');
  });
}
