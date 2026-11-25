import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { RouteLoadError } from '../components/route-error.js';
import { quizQueryOptions } from '../features/quizzes/queries.js';
import { QuizPage } from '../features/quizzes/quiz-page.js';

export const Route = createFileRoute('/quizzes/$id')({
  validateSearch: z.object({ session: z.string().optional() }),
  loader: ({ context, params }) => context.queryClient.ensureQueryData(quizQueryOptions(params.id)),
  errorComponent: () => <RouteLoadError message="Could not open the timed quiz." />,
  component: () => <QuizPage key={Route.useParams().id} />,
});
