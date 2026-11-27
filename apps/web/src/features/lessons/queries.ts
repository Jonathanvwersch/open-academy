import type {
  LessonPayload,
  LessonReviewPayload,
  LessonRunPayload,
} from '@academy/aesop/api/lessons';
import { queryOptions } from '@tanstack/react-query';
import { getJson } from '../../api/query-client.js';
export const lessonQueryOptions = (conceptId: string | null) =>
  queryOptions({
    queryKey: ['lesson', conceptId] as const,
    queryFn: () =>
      conceptId
        ? getJson<LessonPayload>(
            `/api/lessons/${encodeURIComponent(conceptId)}`,
            'Lesson not found',
          )
        : Promise.resolve(null),
  });

export const lessonReviewQueryOptions = (conceptId: string) =>
  queryOptions({
    queryKey: ['lesson-review', conceptId] as const,
    queryFn: () =>
      getJson<LessonReviewPayload>(
        `/api/lessons/${encodeURIComponent(conceptId)}/review`,
        'Lesson not found',
      ),
  });

export const lessonRunQueryOptions = (conceptId: string | null, activityId?: string) =>
  queryOptions({
    queryKey: ['lesson-run', conceptId] as const,
    queryFn: () =>
      conceptId
        ? getJson<LessonRunPayload>(
            `/api/lessons/${encodeURIComponent(conceptId)}/run${activityId ? `?activityId=${encodeURIComponent(activityId)}` : ''}`,
            'Lesson progress unavailable',
          )
        : Promise.resolve({ run: null, course: null }),
  });
