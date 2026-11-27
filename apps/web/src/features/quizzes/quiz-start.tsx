import type { QuizPayload } from '@open-academy/engine/api/quizzes';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent } from '../../components/ui/card.js';
import { postQuiz, quizQueryOptions } from './queries.js';

export function QuizStart({
  sessionId,
  activityId,
  minutes,
}: {
  sessionId: string;
  activityId: string;
  minutes: number;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const start = useMutation({
    mutationFn: () => postQuiz<QuizPayload>('start', { sessionId, activityId }),
    onSuccess: (quiz) => {
      queryClient.setQueryData(quizQueryOptions(quiz.id).queryKey, quiz);
      return navigate({
        to: '/quizzes/$id',
        params: { id: quiz.id },
        search: { session: sessionId },
      });
    },
  });
  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <h1 className="font-semibold">Timed quiz</h1>
        <p>8 questions · About {minutes} minutes</p>
        <p>The timer starts when you open the quiz. It keeps running if you leave.</p>
        <Button disabled={start.isPending} onClick={() => start.mutate()}>
          Open quiz
        </Button>
        {start.isError && (
          <p role="alert" className="text-destructive">
            {start.error.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
