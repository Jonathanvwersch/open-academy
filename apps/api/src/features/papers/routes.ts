import { createHash } from 'node:crypto';
import type { IndexedPaper } from '@open-academy/engine/course/types';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { z } from 'zod';
import { paperFiles } from '../../db/schema.js';
import type { ApiEnv, ApiServices } from '../../http/context.js';
import type { PaperFetcher } from './fetcher.js';
import { defaultPaperFetcher } from './fetcher.js';

const pdfLoads = new Map<string, Promise<Buffer>>();

export function registerPaperRoutes(
  api: Hono<ApiEnv>,
  deps: Pick<ApiServices, 'db' | 'content' | 'learner' | 'tutor'> & {
    paperFetcher?: PaperFetcher;
  },
) {
  const fetcher = deps.paperFetcher ?? defaultPaperFetcher();
  const loadPdf = async (paper: IndexedPaper) => {
    const [cached] = await deps.db
      .select({ bytes: paperFiles.bytes })
      .from(paperFiles)
      .where(eq(paperFiles.paperId, paper.id))
      .limit(1);
    if (cached) return Buffer.from(cached.bytes);
    const existing = pdfLoads.get(paper.id);
    if (existing) return existing;
    const pending = (async () => {
      const bytes = Buffer.from(await fetcher.fetch(paper));
      if (bytes.length > 40 * 1024 * 1024 || bytes.subarray(0, 4).toString() !== '%PDF') {
        throw new Error('Fetched file is not a valid PDF under 40 MB');
      }
      await deps.db
        .insert(paperFiles)
        .values({
          paperId: paper.id,
          bytes,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          fetchedAt: new Date(),
        })
        .onConflictDoNothing();
      return bytes;
    })();
    pdfLoads.set(paper.id, pending);
    try {
      return await pending;
    } finally {
      pdfLoads.delete(paper.id);
    }
  };
  const paperFor = async (id: string) => (await deps.content()).papersById.get(id);

  api.get('/papers', async (c) => {
    const response = await deps.learner(c).papers();
    return c.json(response.body, response.status);
  });
  api.get('/papers/:id', async (c) => {
    const response = await deps.learner(c).paper({ id: c.req.param('id') });
    return c.json(response.body, response.status);
  });
  api.put('/papers/:id/progress', async (c) => {
    const response = await deps.learner(c).savePaperProgress({
      id: c.req.param('id'),
      body: await c.req.json().catch(() => ({})),
    });
    return c.json(response.body, response.status);
  });
  api.post('/papers/:id/summary', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (
      !z.object({ activityId: z.string().uuid().optional() }).passthrough().safeParse(body).success
    ) {
      return c.json({ error: 'Invalid paper summary' }, 400);
    }
    const response = await deps
      .learner(c, {
        judgeSummary: async ({ question, rubric, exemplar, answer }) => {
          const service = deps.tutor(c);
          if (!service) return { reason: 'Tutor grading is disabled.' };
          try {
            const result = await service.gradeExplanation({
              question,
              rubric,
              exemplar,
              answer,
            });
            if (result.status === 'ok' && result.value) return { judgement: result.value };
            return {
              reason:
                result.status === 'budget_exceeded'
                  ? 'Tutor grading limit reached.'
                  : 'Tutor grading failed.',
            };
          } catch {
            return { reason: 'Tutor grading failed.' };
          }
        },
      })
      .submitPaperSummary({
        id: c.req.param('id'),
        body,
      });
    return c.json(response.body, response.status);
  });
  api.get('/papers/:id/pdf', async (c) => {
    const paper = await paperFor(c.req.param('id'));
    if (!paper) return c.json({ error: 'Paper not found' }, 404);
    try {
      const bytes = await loadPdf(paper);
      return c.body(Uint8Array.from(bytes), 200, {
        'Content-Type': 'application/pdf',
        'Cache-Control': 'private, max-age=86400',
      });
    } catch {
      return c.json({ error: 'Paper PDF is unavailable.' }, 502);
    }
  });
}
