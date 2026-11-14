import { asc, eq } from 'drizzle-orm';
import { reviewCards } from '../../db/schema.js';
import { localDateDifference, shiftLocalDate } from '../../http/request-context.js';
import { courseConceptIds, courseFoundations } from '../../learning/prerequisites.js';
import { localDateKey } from '../../learning/xp.js';
import { type FeatureRequest, type FeatureServices, serviceResult } from '../../service-context.js';

export async function getReviews(deps: FeatureServices, request: FeatureRequest) {
  const { db, content } = deps;
  const index = await content();
  const now = request.now();
  const timeZone = request.timeZone;
  const localToday = localDateKey(now, timeZone);
  const [cards, activeCourseId] = await Promise.all([
    db
      .select()
      .from(reviewCards)
      .where(eq(reviewCards.userId, request.userId))
      .orderBy(asc(reviewCards.dueAt)),
    request.repo.activeCourseId(),
  ]);
  const activeCourse = index.coursesById.get(activeCourseId ?? '');
  const activeConceptIds = courseConceptIds(activeCourse);
  const activeFoundationIds = new Set(
    activeCourse ? courseFoundations(index, activeCourse.id).map((concept) => concept.id) : [],
  );
  const curriculumCourseIds = index.curriculum?.courses ?? index.courses.map((course) => course.id);
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
      const activeContains = activeConceptIds.has(conceptId) || activeFoundationIds.has(conceptId);
      const course =
        (activeContains ? activeCourse : undefined) ??
        curriculumCourseIds
          .map((courseId) => index.coursesById.get(courseId))
          .find((candidate) => candidate?.units.some((unit) => unit.concepts.includes(conceptId)));
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
          due: earliest <= now,
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
