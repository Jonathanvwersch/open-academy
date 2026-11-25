import type { Hono } from 'hono';
import type { ApiEnv, ApiServices } from '../../http/context.js';
import { featureRequest } from '../../http/feature-service.js';
import {
  answerQuiz,
  finalizeQuiz,
  getQuiz,
  startQuiz,
  startQuizFollowUps,
  startQuizRetake,
} from './service.js';

export function registerQuizRoutes(api: Hono<ApiEnv>, deps: ApiServices) {
  api.post('/quizzes/start', async (context) => {
    const response = await startQuiz(
      deps,
      featureRequest(context, deps, await context.req.json().catch(() => ({}))),
    );
    return context.json(response.body, response.status);
  });
  api.get('/quizzes/:id', async (context) => {
    const response = await getQuiz(deps, featureRequest(context, deps));
    return context.json(response.body, response.status);
  });
  api.post('/quizzes/:id/answer', async (context) => {
    const response = await answerQuiz(
      deps,
      featureRequest(context, deps, await context.req.json().catch(() => ({}))),
    );
    return context.json(response.body, response.status);
  });
  api.post('/quizzes/:id/finalize', async (context) => {
    const response = await finalizeQuiz(deps, featureRequest(context, deps));
    return context.json(response.body, response.status);
  });
  api.post('/quizzes/:id/follow-ups', async (context) => {
    const response = await startQuizFollowUps(deps, featureRequest(context, deps));
    return context.json(response.body, response.status);
  });
  api.post('/quizzes/:id/retake', async (context) => {
    const response = await startQuizRetake(deps, featureRequest(context, deps));
    return context.json(response.body, response.status);
  });
}
