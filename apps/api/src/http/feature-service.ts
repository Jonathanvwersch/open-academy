import type { Context } from 'hono';
import type { FeatureRequest } from '../service-context.js';
import type { ApiEnv, ApiServices } from './context.js';
export function featureRequest(
  context: Context<ApiEnv>,
  deps: ApiServices,
  body?: unknown,
): FeatureRequest {
  return {
    userId: context.get('userId'),
    timeZone: context.get('timeZone'),
    params: context.req.param(),
    query: context.req.query(),
    body,
    repo: deps.withRepo(context),
    tutor: deps.tutor(context),
    now: () => deps.requestNow(context),
  };
}
