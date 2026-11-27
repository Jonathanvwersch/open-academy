import type { QuizPayload } from '@open-academy/engine/api/quizzes';
import { queryOptions } from '@tanstack/react-query';
import { apiFetch } from '../../api/authenticated-fetch.js';
import { getJson } from '../../api/query-client.js';

export const quizQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['quiz', id] as const,
    queryFn: () =>
      getJson<QuizPayload>(`/api/quizzes/${encodeURIComponent(id)}`, 'Could not load quiz'),
  });

export async function postQuiz<T>(path: string, body?: unknown): Promise<T> {
  const response = await apiFetch(`/api/quizzes/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Could not continue the quiz.');
  return data as T;
}
