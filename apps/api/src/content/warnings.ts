import { orderCourseIdsBySubject } from './course-order.js';
import { buildContentIndex, subjectForCourse } from './index.js';
import type { ContentIssue, ContentSourceData } from './types.js';

type CourseEntry = ContentSourceData['courses'][number];
type ConceptEntry = ContentSourceData['concepts'][number];

function flattenedTopics(course: CourseEntry): Array<{ id: string; unit: number }> {
  return course.value.units.flatMap((unit, index) =>
    unit.concepts.map((id) => ({ id, unit: index + 1 })),
  );
}

function hardPrerequisiteIds(concept: ConceptEntry['value']): string[] {
  return concept.prereqs
    .filter((prerequisite) => prerequisite.strength === 'hard')
    .map(({ id }) => id);
}

export function contentWarnings(data: ContentSourceData): ContentIssue[] {
  const content = buildContentIndex(data);
  const concepts = new Map(data.concepts.map((entry) => [entry.value.id, entry]));
  const courses = new Map(data.courses.map((entry) => [entry.value.id, entry]));
  const orderedCourseIds = orderCourseIdsBySubject(
    content,
    data.courses.map(({ value }) => value.id),
  );
  const topicsByCourse = new Map(
    orderedCourseIds.map((courseId) => {
      const course = courses.get(courseId);
      return [courseId, course ? flattenedTopics(course) : []];
    }),
  );
  const conceptIdsByCourse = new Map(
    orderedCourseIds.map((courseId) => [
      courseId,
      new Set((topicsByCourse.get(courseId) ?? []).map(({ id }) => id)),
    ]),
  );
  const courseIdsBySubject = new Map<string, string[]>();

  for (const courseId of orderedCourseIds) {
    const subjectId = subjectForCourse(content, courseId).id;
    const courseIds = courseIdsBySubject.get(subjectId) ?? [];
    courseIds.push(courseId);
    courseIdsBySubject.set(subjectId, courseIds);
  }

  const positionByCourse = new Map<string, number>();
  for (const courseIds of courseIdsBySubject.values()) {
    courseIds.forEach((courseId, position) => {
      positionByCourse.set(courseId, position);
    });
  }

  const warnings: ContentIssue[] = [];
  const warnedConcepts = new Set<string>();

  for (const courseId of orderedCourseIds) {
    const course = courses.get(courseId);
    if (!course) continue;
    const topics = topicsByCourse.get(courseId) ?? [];

    for (const [position, topic] of topics.entries()) {
      const concept = concepts.get(topic.id);
      if (
        !concept ||
        warnedConcepts.has(topic.id) ||
        concept.value.prereqs.length > 0 ||
        (topic.unit === 1 && position < 3)
      ) {
        continue;
      }
      warnings.push({
        file: concept.file,
        id: topic.id,
        message: `has no prerequisites but sits in unit ${topic.unit} of ${course.value.title}; is a link missing?`,
      });
      warnedConcepts.add(topic.id);
    }

    const topicIds = new Set(topics.map(({ id }) => id));
    if (topics.length >= 6) {
      const done = new Set<string>();
      let maximumOpen = 0;

      for (const { id } of topics) {
        const open = topics.filter(({ id: candidateId }) => {
          if (done.has(candidateId)) return false;
          const concept = concepts.get(candidateId);
          if (!concept) return false;
          return hardPrerequisiteIds(concept.value).every(
            (prerequisiteId) => !topicIds.has(prerequisiteId) || done.has(prerequisiteId),
          );
        }).length;
        maximumOpen = Math.max(maximumOpen, open);
        done.add(id);
      }

      if (maximumOpen <= 1) {
        warnings.push({
          file: course.file,
          id: course.value.id,
          message:
            'every topic waits on the one before it, so learners only ever have one topic open; check each hard prerequisite is really needed',
        });
      }
    }

    const firstUnit = course.value.units[0];
    const subject = subjectForCourse(content, courseId);
    const currentPosition = positionByCourse.get(courseId);
    if (!firstUnit || currentPosition === undefined) continue;
    const prereqIds = new Set(
      firstUnit.concepts.flatMap((conceptId) => {
        const concept = concepts.get(conceptId);
        return concept ? hardPrerequisiteIds(concept.value) : [];
      }),
    );

    for (const prerequisiteId of prereqIds) {
      if (topicIds.has(prerequisiteId)) continue;
      const containingCourseIds = orderedCourseIds.filter((candidateId) =>
        conceptIdsByCourse.get(candidateId)?.has(prerequisiteId),
      );
      if (containingCourseIds.length === 0) continue;
      const laterCourseIds = containingCourseIds.filter(
        (candidateId) =>
          subjectForCourse(content, candidateId).id === subject.id &&
          (positionByCourse.get(candidateId) ?? -1) > currentPosition,
      );
      if (laterCourseIds.length !== containingCourseIds.length) continue;
      const laterCourse = courses.get(laterCourseIds[0] ?? '');
      const prerequisite = concepts.get(prerequisiteId);
      if (!laterCourse || !prerequisite) continue;
      warnings.push({
        file: course.file,
        id: course.value.id,
        message: `unit 1 needs ${prerequisite.value.title} from ${laterCourse.value.title}, which comes later in ${subject.title}; move the topic or reorder the courses`,
      });
    }
  }

  return warnings;
}
