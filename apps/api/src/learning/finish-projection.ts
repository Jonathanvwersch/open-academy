import { SCHEDULER_CONFIG } from './scheduler.js';
import { XP_PER_REMAINING_TOPIC } from './xp.js';

export interface ProjectionCourse {
  id: string;
  subjectId?: string;
  subjectOrder?: number;
  title?: string;
  topics: Array<{
    conceptId: string;
    status?: 'authored' | 'stub';
    done: boolean;
    hardPrereqIds: string[];
    title?: string;
    unitTitle?: string;
    completionDate?: string;
    displayCourseId?: string;
    displayCourseTitle?: string;
    displayUnitTitle?: string;
  }>;
}

export interface ProjectedTopic {
  conceptId: string;
  courseId: string;
  courseTitle: string;
  title: string;
  unitTitle: string;
  date?: string;
}

type DatedProjectedTopic = ProjectedTopic & { date: string };

export interface TopicAttribution {
  courseId: string;
  courseTitle: string;
  unitTitle: string;
}

export function courseTopicAttribution(
  conceptId: string,
  orderedCourses: readonly {
    id: string;
    title: string;
    subjectId?: string;
    units: readonly { title: string; concepts: readonly string[] }[];
  }[],
  foundationCourse: TopicAttribution,
  preferredSubjectId?: string,
): TopicAttribution {
  const prioritizedCourses = preferredSubjectId
    ? [
        ...orderedCourses.filter((course) => course.subjectId === preferredSubjectId),
        ...orderedCourses.filter((course) => course.subjectId !== preferredSubjectId),
      ]
    : orderedCourses;
  for (const course of prioritizedCourses) {
    const unit = course.units.find((candidate) => candidate.concepts.includes(conceptId));
    if (unit) return { courseId: course.id, courseTitle: course.title, unitTitle: unit.title };
  }
  return { ...foundationCourse, courseTitle: `${foundationCourse.courseTitle} · Foundations` };
}

export function projectCourseFinishes(input: {
  courses: ProjectionCourse[];
  assumedDoneConceptIds?: ReadonlySet<string>;
  spentBySubject?: Readonly<Record<string, number>>;
  dailyXp: number;
  today: string;
  xpPerTopic?: number;
  maxNewTopicsPerDay?: number;
  maxDays?: number;
}): {
  byCourse: Map<string, string | null>;
  overall: string | null;
  upcoming: DatedProjectedTopic[];
  finished: ProjectedTopic[];
} {
  const courses = input.courses.map((course) => ({
    ...course,
    topics: course.topics.filter((topic) => topic.status !== 'stub'),
  }));
  const byCourse = new Map<string, string | null>(courses.map((course) => [course.id, null]));
  const finishedByConcept = new Map<string, ProjectedTopic>();
  for (const course of courses) {
    for (const topic of course.topics) {
      if (!topic.done || finishedByConcept.has(topic.conceptId)) continue;
      finishedByConcept.set(topic.conceptId, projectedTopic(course, topic, topic.completionDate));
    }
  }
  if (input.dailyXp <= 0 || courses.length === 0) {
    return {
      byCourse,
      overall: null,
      upcoming: [],
      finished: newestFirst(finishedByConcept.values()),
    };
  }

  const xpPerTopic = input.xpPerTopic ?? XP_PER_REMAINING_TOPIC;
  const maxNewTopicsPerDay = Math.max(
    0,
    Math.floor(input.maxNewTopicsPerDay ?? SCHEDULER_CONFIG.weekday.maxNewConcepts),
  );
  const maxDays = Math.max(0, Math.floor(input.maxDays ?? 3650));
  const doneConcepts = new Set([
    ...courses.flatMap((course) =>
      course.topics.filter((topic) => topic.done).map((topic) => topic.conceptId),
    ),
    ...(input.assumedDoneConceptIds ?? []),
  ]);
  const unfinishedCourses = new Set(
    courses
      .filter((course) => course.topics.some((topic) => !doneConcepts.has(topic.conceptId)))
      .map((course) => course.id),
  );
  const spentBySubject = new Map(Object.entries(input.spentBySubject ?? {}));
  const progressByConcept = new Map<string, number>();
  const upcomingByConcept = new Map<string, DatedProjectedTopic>();
  let partialTopic: { conceptId: string; courseId: string; subjectId: string } | null = null;
  for (let day = 1; day <= maxDays && unfinishedCourses.size > 0; day += 1) {
    if (maxNewTopicsPerDay === 0) break;
    let remainingXp = input.dailyXp;
    let topicsToday = 0;

    if (partialTopic) {
      topicsToday = 1;
      const spent = spendOnTopic(
        partialTopic.conceptId,
        partialTopic.subjectId,
        remainingXp,
        xpPerTopic,
        progressByConcept,
        doneConcepts,
        spentBySubject,
      );
      remainingXp -= spent.xp;
      if (spent.completed) partialTopic = null;
      else continue;
    }

    while (remainingXp > 0 && topicsToday < maxNewTopicsPerDay) {
      const topic = nextAvailableTopic(courses, unfinishedCourses, doneConcepts, spentBySubject);
      if (!topic) break;
      topicsToday += 1;
      const topicCourse = courses.find((course) => course.id === topic.courseId);
      const topicDetails = topicCourse?.topics.find(
        (candidate) => candidate.conceptId === topic.conceptId,
      );
      if (topicCourse && topicDetails && !upcomingByConcept.has(topic.conceptId)) {
        upcomingByConcept.set(
          topic.conceptId,
          projectedTopic(topicCourse, topicDetails, addLocalDays(input.today, day - 1)),
        );
      }
      const spent = spendOnTopic(
        topic.conceptId,
        topic.subjectId,
        remainingXp,
        xpPerTopic,
        progressByConcept,
        doneConcepts,
        spentBySubject,
      );
      remainingXp -= spent.xp;
      if (!spent.completed) {
        partialTopic = {
          conceptId: topic.conceptId,
          courseId: topic.courseId,
          subjectId: topic.subjectId,
        };
        break;
      }
    }

    if (topicsToday === 0) break;
    const date = addLocalDays(input.today, day);
    for (const course of courses) {
      if (
        unfinishedCourses.has(course.id) &&
        course.topics.every((topic) => doneConcepts.has(topic.conceptId))
      ) {
        byCourse.set(course.id, date);
        unfinishedCourses.delete(course.id);
      }
    }
  }

  const dates = [...byCourse.values()];
  const nonNullDates = dates.filter((date): date is string => date !== null).sort();
  const overall = unfinishedCourses.size > 0 ? null : (nonNullDates.at(-1) ?? null);
  return {
    byCourse,
    overall,
    upcoming: [...upcomingByConcept.values()].slice(0, 20),
    finished: newestFirst(finishedByConcept.values()),
  };
}

function newestFirst(topics: Iterable<ProjectedTopic>): ProjectedTopic[] {
  return [...topics].sort((left, right) => (right.date ?? '').localeCompare(left.date ?? ''));
}

function nextAvailableTopic(
  courses: ProjectionCourse[],
  unfinishedCourses: ReadonlySet<string>,
  doneConcepts: ReadonlySet<string>,
  spentBySubject: ReadonlyMap<string, number>,
) {
  const frontCourseBySubject = new Map<
    string,
    { conceptId: string; courseId: string; subjectId: string; subjectOrder: number }
  >();
  courses.forEach((course) => {
    const subjectId = course.subjectId ?? 'default';
    if (frontCourseBySubject.has(subjectId) || !unfinishedCourses.has(course.id)) return;
    const topic = course.topics.find(
      (candidate) =>
        !doneConcepts.has(candidate.conceptId) &&
        candidate.hardPrereqIds.every((prereqId) => doneConcepts.has(prereqId)),
    );
    if (topic) {
      frontCourseBySubject.set(subjectId, {
        conceptId: topic.conceptId,
        courseId: course.id,
        subjectId,
        subjectOrder: course.subjectOrder ?? Infinity,
      });
    }
  });
  return [...frontCourseBySubject.values()].sort(
    (left, right) =>
      (spentBySubject.get(left.subjectId) ?? 0) - (spentBySubject.get(right.subjectId) ?? 0) ||
      left.subjectOrder - right.subjectOrder,
  )[0];
}

function spendOnTopic(
  conceptId: string,
  subjectId: string,
  availableXp: number,
  xpPerTopic: number,
  progressByConcept: Map<string, number>,
  doneConcepts: Set<string>,
  spentBySubject: Map<string, number>,
) {
  const alreadySpent = progressByConcept.get(conceptId) ?? 0;
  const neededXp = Math.max(0, xpPerTopic - alreadySpent);
  const xp = Math.min(availableXp, neededXp);
  const progress = alreadySpent + xp;
  spentBySubject.set(subjectId, (spentBySubject.get(subjectId) ?? 0) + xp);
  if (progress >= xpPerTopic) {
    progressByConcept.delete(conceptId);
    doneConcepts.add(conceptId);
    return { xp, completed: true };
  }
  progressByConcept.set(conceptId, progress);
  return { xp, completed: false };
}

function projectedTopic(
  course: ProjectionCourse,
  topic: ProjectionCourse['topics'][number],
  date: string,
): DatedProjectedTopic;
function projectedTopic(
  course: ProjectionCourse,
  topic: ProjectionCourse['topics'][number],
  date?: string,
): ProjectedTopic;
function projectedTopic(
  course: ProjectionCourse,
  topic: ProjectionCourse['topics'][number],
  date?: string,
): ProjectedTopic {
  return {
    conceptId: topic.conceptId,
    courseId: topic.displayCourseId ?? course.id,
    courseTitle: topic.displayCourseTitle ?? course.title ?? course.id,
    title: topic.title ?? topic.conceptId,
    unitTitle: topic.displayUnitTitle ?? topic.unitTitle ?? '',
    ...(date ? { date } : {}),
  };
}

function addLocalDays(localDate: string, days: number): string {
  const date = new Date(`${localDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
