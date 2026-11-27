import type { LearnPayload } from '@academy/aesop/api/course';
import { queryOptions } from '@tanstack/react-query';
import { getJson } from '../../api/query-client.js';

export const studyMapQueryOptions = () =>
  queryOptions({
    queryKey: ['study-map'] as const,
    queryFn: async () => {
      const learn = await getJson<LearnPayload>('/api/learn', 'Could not load Up next');
      const focusSubjectTitle =
        learn.activeSubjects?.find((subject) => subject.id === learn.focusSubjectId)?.title ?? null;
      return { ...learn.upNext, focusSubjectTitle };
    },
  });
