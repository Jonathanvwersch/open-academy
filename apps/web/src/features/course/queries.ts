import type {
  CourseCatalogPayload,
  CourseDetailPayload,
  CoursePayload,
  LearnPayload,
} from '@academy/contracts/course';
import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { getJson } from '../../api/query-client.js';
import { studyMapQueryOptions } from '../map/queries.js';
import { papersQueryOptions } from '../papers/queries.js';
import { reviewsQueryOptions } from '../reviews/queries.js';
import { todayQueryOptions } from '../sessions/queries.js';

export const learnQueryOptions = () =>
  queryOptions({
    queryKey: ['learn'] as const,
    queryFn: () => getJson<LearnPayload>('/api/learn', 'Could not load Learn'),
  });

export const courseQueryKeyRoot = ['course'] as const;
export const coursesQueryKeyRoot = ['courses'] as const;

export const courseQueryOptions = (courseId?: string) =>
  queryOptions({
    queryKey: ['course', courseId ?? null] as const,
    queryFn: () =>
      getJson<CoursePayload>(
        courseId ? `/api/course?course=${encodeURIComponent(courseId)}` : '/api/course',
        'Could not load Course',
      ),
  });

export const coursesQueryOptions = () =>
  queryOptions({
    queryKey: coursesQueryKeyRoot,
    queryFn: () => getJson<CourseCatalogPayload>('/api/courses', 'Could not load Courses'),
  });

export const courseDetailQueryOptions = (courseId: string) =>
  queryOptions({
    queryKey: ['course', courseId] as const,
    queryFn: () =>
      getJson<CourseDetailPayload>(
        `/api/courses/${encodeURIComponent(courseId)}`,
        'Could not load Course',
      ),
  });

export function invalidateSidebarQueries(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: studyMapQueryOptions().queryKey }),
    queryClient.invalidateQueries({ queryKey: courseQueryKeyRoot }),
    queryClient.invalidateQueries({ queryKey: reviewsQueryOptions().queryKey }),
  ]);
}

export function invalidateCourseStudyQueries(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: studyMapQueryOptions().queryKey }),
    queryClient.invalidateQueries({ queryKey: courseQueryKeyRoot }),
    queryClient.invalidateQueries({ queryKey: coursesQueryKeyRoot }),
    queryClient.invalidateQueries({ queryKey: learnQueryOptions().queryKey }),
    queryClient.invalidateQueries({ queryKey: todayQueryOptions().queryKey }),
    queryClient.invalidateQueries({ queryKey: papersQueryOptions().queryKey }),
    queryClient.invalidateQueries({ queryKey: reviewsQueryOptions().queryKey }),
  ]);
}

export const conceptQueryOptions = (conceptId: string) =>
  queryOptions({
    queryKey: ['concept', conceptId] as const,
    queryFn: () =>
      getJson<Record<string, unknown>>(
        `/api/concepts/${encodeURIComponent(conceptId)}`,
        'Concept unavailable',
      ),
  });
