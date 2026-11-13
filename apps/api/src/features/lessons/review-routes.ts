import type { Hono } from 'hono';
import type { ApiEnv, ApiServices } from '../../http/context.js';
import { featureRequest } from '../../http/feature-service.js';
import { getLessonsByConceptId, getLessonsByConceptIdReview } from './review-service.js';
export function registerLessonsRoutes(api: Hono<ApiEnv>, deps: ApiServices) {
  api.get('/lessons/:conceptId', async (context) => {
    const response = await getLessonsByConceptId(deps, featureRequest(context, deps));
    return context.json(response.body, response.status);
  });
  api.get('/lessons/:conceptId/review', async (context) => {
    const response = await getLessonsByConceptIdReview(deps, featureRequest(context, deps));
    return context.json(response.body, response.status);
  });
}
