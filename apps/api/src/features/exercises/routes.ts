import type { EngineGenerateHint, EngineResult } from '@open-academy/engine/engine/create-engine';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { ApiEnv, ApiServices } from '../../http/context.js';
import { judgeExplanation } from '../tutor/judge-explanation.js';

const send = (context: Context<ApiEnv>, result: EngineResult) =>
  context.json(result.body, result.status);

export function registerExercisesRoutes(api: Hono<ApiEnv>, deps: ApiServices) {
  api.get('/exercises/:id', async (context) => {
    return send(context, await deps.learner(context).exercise({ id: context.req.param('id') }));
  });
  api.post('/hints', async (context) => {
    const body = await context.req.json().catch(() => ({}));
    if (
      !z.object({ activityId: z.string().uuid().optional() }).passthrough().safeParse(body).success
    ) {
      return context.json({ error: 'Invalid hint request' }, 400);
    }
    const generateHint: EngineGenerateHint = async ({ prompt, level }) => {
      const tutor = deps.tutor(context);
      if (!tutor) return { kind: 'disabled' as const };
      const index = await deps.content();
      const generated = await tutor.respond({ ...prompt, history: [] }, level, index);
      return generated.status === 'ok' && generated.value
        ? { kind: 'ok' as const, text: generated.value.message_md }
        : { kind: 'unavailable' as const };
    };
    return send(context, await deps.learner(context, { generateHint }).hint({ body }));
  });
  api.post('/attempts', async (context) => {
    const body = await context.req.json().catch(() => ({}));
    if (
      !z.object({ activityId: z.string().uuid().optional() }).passthrough().safeParse(body).success
    ) {
      return context.json({ error: 'Invalid attempt' }, 400);
    }
    return send(
      context,
      await deps
        .learner(context, { judgeExplanation: judgeExplanation(deps.tutor(context)) })
        .exerciseAttempt({
          body,
        }),
    );
  });
}
