import type { Hono } from 'hono';
import type { ApiEnv, ApiServices } from '../../http/context.js';
import { featureRequest } from '../../http/feature-service.js';
import {
  getDiagnosticByIdNext,
  getDiagnosticByIdResults,
  getDiagnosticLatest,
  postDiagnostic,
  postDiagnosticByIdAnswer,
  postDiagnosticByIdSkip,
} from './service.js';
export function registerDiagnosticRoutes(api: Hono<ApiEnv>, deps: ApiServices) {
  api.post('/diagnostic', async (context) => {
    const response = await postDiagnostic(deps, featureRequest(context, deps));
    return context.json(response.body, response.status);
  });
  api.get('/diagnostic/:id/next', async (context) => {
    const response = await getDiagnosticByIdNext(deps, featureRequest(context, deps));
    return context.json(response.body, response.status);
  });
  api.post('/diagnostic/:id/skip', async (context) => {
    const response = await postDiagnosticByIdSkip(
      deps,
      featureRequest(context, deps, await context.req.json().catch(() => ({}))),
    );
    return context.json(response.body, response.status);
  });
  api.post('/diagnostic/:id/answer', async (context) => {
    const response = await postDiagnosticByIdAnswer(
      deps,
      featureRequest(context, deps, await context.req.json()),
    );
    return context.json(response.body, response.status);
  });
  api.get('/diagnostic/latest', async (context) => {
    const response = await getDiagnosticLatest(deps, featureRequest(context, deps));
    return context.json(response.body, response.status);
  });
  api.get('/diagnostic/:id/results', async (context) => {
    const response = await getDiagnosticByIdResults(deps, featureRequest(context, deps));
    return context.json(response.body, response.status);
  });
}
