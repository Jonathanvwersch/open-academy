import { createFileRoute, redirect } from '@tanstack/react-router';
import { z } from 'zod';

export const Route = createFileRoute('/course')({
  validateSearch: z.object({ course: z.string().optional() }),
  beforeLoad: ({ search }) => {
    if (search.course) {
      throw redirect({ to: '/courses/$courseId', params: { courseId: search.course } });
    }
    throw redirect({ to: '/courses' });
  },
});
