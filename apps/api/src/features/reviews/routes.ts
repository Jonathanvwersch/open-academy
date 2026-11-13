import type { Hono } from 'hono';
import type { ApiEnv, ApiServices } from '../../http/context.js';
import { featureRequest } from '../../http/feature-service.js';
import { getReviews } from './service.js';
export function registerReviewsRoutes(api: Hono<ApiEnv>, deps: ApiServices) {
  api.get('/reviews', async (context) => {
    const response = await getReviews(deps, featureRequest(context, deps));
    return context.json(response.body, response.status);
  });
}
