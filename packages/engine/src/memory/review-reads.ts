import type { ReviewsPayload } from '../api/reviews.js';
import { orderCourseIdsBySubject } from '../course/course-order.js';
import type { ContentIndex } from '../course/types.js';
import { courseConceptIds, courseFoundationIds } from '../graph/prerequisites.js';
import { localDateDifference, localDateKey, shiftLocalDate } from '../progress/xp.js';
import type { CourseStore } from '../store/course-store.js';
import { isDueToday } from './fsrs.js';

export async function readReviews(
  store: CourseStore,
  input: {
    userId: string;
    content: ContentIndex;
    now: Date;
    timeZone: string;
    studyCourseIds: readonly string[];
    activeCourseId: () => Promise<string | null>;
  },
): Promise<ReviewsPayload> {
  const { userId, content, now, timeZone, studyCourseIds: courseIds } = input;
  const localToday = localDateKey(now, timeZone);
  const [cards, activeCourseId] = await Promise.all([
    store.listReviewCards(userId, undefined, { activeOnly: true }),
    input.activeCourseId(),
  ]);
  const studyCourseIds = orderCourseIdsBySubject(content, courseIds);
  cards.sort((left, right) => left.dueAt.getTime() - right.dueAt.getTime());
  const activeCourse = content.coursesById.get(activeCourseId ?? '');
  const preferredCourseIds = [
    ...studyCourseIds,
    ...(activeCourse ? [activeCourse.id] : []),
    ...orderCourseIdsBySubject(content),
  ];
  const courseTopicSets = new Map(
    preferredCourseIds.map((courseId) => {
      const course = content.coursesById.get(courseId);
      return [
        courseId,
        new Set([...courseConceptIds(course), ...courseFoundationIds(content, courseId)]),
      ] as const;
    }),
  );
  const cardsByConcept = new Map<string, typeof cards>();
  for (const card of cards) {
    if (!content.conceptsById.has(card.conceptId)) continue;
    const rows = cardsByConcept.get(card.conceptId) ?? [];
    rows.push(card);
    cardsByConcept.set(card.conceptId, rows);
  }
  const topics = [...cardsByConcept]
    .flatMap(([conceptId, conceptCards]) => {
      const concept = content.conceptsById.get(conceptId);
      if (!concept || concept.status === 'stub') return [];
      const firstCard = conceptCards[0];
      if (!firstCard) return [];
      const earliest = new Date(Math.min(...conceptCards.map((card) => card.dueAt.getTime())));
      const courseId = preferredCourseIds.find((candidateId) =>
        courseTopicSets.get(candidateId)?.has(conceptId),
      );
      const course = courseId ? content.coursesById.get(courseId) : undefined;
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
  return {
    dueNow: topics.filter((topic) => topic.due).length,
    upcoming: upcomingDates.map((date) => ({ date, count: upcomingCounts.get(date) ?? 0 })),
    topics,
  };
}
