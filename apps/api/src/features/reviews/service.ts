import { asc, eq } from 'drizzle-orm';
import { reviewCards } from '../../db/schema.js';
import { localDateDifference, shiftLocalDate } from '../../http/request-context.js';
import { retrievability } from '../../learning/fsrs.js';
import { localDateKey } from '../../learning/xp.js';
import { type FeatureRequest, type FeatureServices, serviceResult } from '../../service-context.js';

export async function getReviews(deps: FeatureServices, request: FeatureRequest) {
  const { db, content } = deps;
  const index = await content();
  const now = request.now();
  const timeZone = request.timeZone;
  const localToday = localDateKey(now, timeZone);
  const cards = await db
    .select()
    .from(reviewCards)
    .where(eq(reviewCards.userId, request.userId))
    .orderBy(asc(reviewCards.dueAt));
  const topics = cards.flatMap((card) => {
    const concept = index.conceptsById.get(card.conceptId);
    if (!concept || concept.status === 'stub') return [];
    return [
      {
        conceptId: card.conceptId,
        title: concept.title,
        dimension: card.dimension,
        dueAt: card.dueAt.toISOString(),
        due: card.dueAt <= now,
        dueInDays: localDateDifference(localToday, localDateKey(card.dueAt, timeZone)),
        lastReviewAt: card.lastReviewAt?.toISOString() ?? null,
        reps: card.reps,
        lapses: card.lapses,
        recall: retrievability(card.fsrs as never, now, process.env.NODE_ENV !== 'test'),
      },
    ];
  });
  const upcomingDates = Array.from({ length: 7 }, (_, index) =>
    shiftLocalDate(localToday, index + 1),
  );
  const upcomingCounts = new Map(upcomingDates.map((date) => [date, 0]));
  for (const topic of topics) {
    const date = localDateKey(new Date(topic.dueAt), timeZone);
    if (upcomingCounts.has(date)) upcomingCounts.set(date, (upcomingCounts.get(date) ?? 0) + 1);
  }
  return serviceResult({
    dueNow: topics.filter((topic) => topic.due).length,
    upcoming: upcomingDates.map((date) => ({ date, count: upcomingCounts.get(date) ?? 0 })),
    topics,
  });
}
