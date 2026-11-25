import { orderCourseIdsBySubject } from '@academy/aesop/course/course-order';
import { courseConceptIds, courseFoundationIds } from '@academy/aesop/graph/prerequisites';
import { isDueToday } from '@academy/aesop/memory/fsrs';
import { localDateKey } from '@academy/aesop/progress/xp';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { reviewCards } from '../../db/schema.js';
import { localDateDifference, shiftLocalDate } from '../../http/request-context.js';
import { type FeatureRequest, type FeatureServices, serviceResult } from '../../service-context.js';

export async function getReviews(deps: FeatureServices, request: FeatureRequest) {
  const { db, content } = deps;
  const index = await content();
  const now = request.now();
  const timeZone = request.timeZone;
  const localToday = localDateKey(now, timeZone);
  const studyCourseIds = orderCourseIdsBySubject(index, await request.repo.studyCourseIds(index));
  const [cards, activeCourseId] = await Promise.all([
    db
      .select()
      .from(reviewCards)
      .where(and(eq(reviewCards.userId, request.userId), isNull(reviewCards.suspendedAt)))
      .orderBy(asc(reviewCards.dueAt)),
    request.repo.activeCourseId(),
  ]);
  const activeCourse = index.coursesById.get(activeCourseId ?? '');
  const preferredCourseIds = [
    ...studyCourseIds,
    ...(activeCourse ? [activeCourse.id] : []),
    ...orderCourseIdsBySubject(index),
  ];
  const courseTopicSets = new Map(
    preferredCourseIds.map((courseId) => {
      const course = index.coursesById.get(courseId);
      return [
        courseId,
        new Set([...courseConceptIds(course), ...courseFoundationIds(index, courseId)]),
      ] as const;
    }),
  );
  const cardsByConcept = new Map<string, typeof cards>();
  for (const card of cards) {
    if (!index.conceptsById.has(card.conceptId)) continue;
    const rows = cardsByConcept.get(card.conceptId) ?? [];
    rows.push(card);
    cardsByConcept.set(card.conceptId, rows);
  }
  const topics = [...cardsByConcept]
    .flatMap(([conceptId, conceptCards]) => {
      const concept = index.conceptsById.get(conceptId);
      if (!concept || concept.status === 'stub') return [];
      const firstCard = conceptCards[0];
      if (!firstCard) return [];
      const earliest = new Date(Math.min(...conceptCards.map((card) => card.dueAt.getTime())));
      const courseId = preferredCourseIds.find((candidateId) =>
        courseTopicSets.get(candidateId)?.has(conceptId),
      );
      const course = courseId ? index.coursesById.get(courseId) : undefined;
      const kinds = [...new Set(conceptCards.map((card) => card.dimension))].sort(
        (left, right) =>
          ['conceptual', 'math', 'implementation', 'transfer'].indexOf(left) -
          ['conceptual', 'math', 'implementation', 'transfer'].indexOf(right),
      );
      return [
        {
          conceptId,
          title: concept.title,
          courseId: course?.id ?? null,
          courseTitle: course?.title ?? null,
          kinds,
          dueAt: earliest.toISOString(),
          due: isDueToday(earliest, now, timeZone),
          dueInDays: localDateDifference(localToday, localDateKey(earliest, timeZone)),
        },
      ];
    })
    .sort(
      (left, right) =>
        left.dueAt.localeCompare(right.dueAt) || left.title.localeCompare(right.title),
    );
  const upcomingDates = Array.from({ length: 7 }, (_, index) =>
    shiftLocalDate(localToday, index + 1),
  );
  const upcomingCounts = new Map(upcomingDates.map((date) => [date, 0]));
  for (const topic of topics) {
    if (topic.due) continue;
    const date = localDateKey(new Date(topic.dueAt), timeZone);
    if (upcomingCounts.has(date)) upcomingCounts.set(date, (upcomingCounts.get(date) ?? 0) + 1);
  }
  return serviceResult({
    dueNow: topics.filter((topic) => topic.due).length,
    upcoming: upcomingDates.map((date) => ({ date, count: upcomingCounts.get(date) ?? 0 })),
    topics,
  });
}
