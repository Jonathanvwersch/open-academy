import { SCHEDULER_CONFIG } from './scheduler.js';
import { XP_PER_REMAINING_TOPIC } from './xp.js';

export interface ProjectionCourse {
  id: string;
  topics: Array<{ conceptId: string; done: boolean; hardPrereqIds: string[] }>;
}

export function projectCourseFinishes(input: {
  courses: ProjectionCourse[];
  dailyXp: number;
  today: string;
  xpPerTopic?: number;
  maxNewTopicsPerDay?: number;
  maxDays?: number;
}): { byCourse: Map<string, string | null>; overall: string | null } {
  const byCourse = new Map<string, string | null>(input.courses.map((course) => [course.id, null]));
  if (input.dailyXp <= 0 || input.courses.length === 0) return { byCourse, overall: null };

  const xpPerTopic = input.xpPerTopic ?? XP_PER_REMAINING_TOPIC;
  const maxNewTopicsPerDay = Math.max(
    0,
    Math.floor(input.maxNewTopicsPerDay ?? SCHEDULER_CONFIG.weekday.maxNewConcepts),
  );
  const maxDays = Math.max(0, Math.floor(input.maxDays ?? 3650));
  const doneConcepts = new Set(
    input.courses.flatMap((course) =>
      course.topics.filter((topic) => topic.done).map((topic) => topic.conceptId),
    ),
  );
  const unfinishedCourses = new Set(
    input.courses
      .filter((course) => course.topics.some((topic) => !doneConcepts.has(topic.conceptId)))
      .map((course) => course.id),
  );
  const spentByCourse = new Map(input.courses.map((course) => [course.id, 0]));
  const progressByConcept = new Map<string, number>();
  let partialTopic: { conceptId: string; courseId: string } | null = null;
  for (let day = 1; day <= maxDays && unfinishedCourses.size > 0; day += 1) {
    if (maxNewTopicsPerDay === 0) break;
    let remainingXp = input.dailyXp;
    let topicsToday = 0;

    if (partialTopic) {
      topicsToday = 1;
      const spent = spendOnTopic(
        partialTopic.conceptId,
        partialTopic.courseId,
        remainingXp,
        xpPerTopic,
        progressByConcept,
        doneConcepts,
        spentByCourse,
      );
      remainingXp -= spent.xp;
      if (spent.completed) partialTopic = null;
      else continue;
    }

    while (remainingXp > 0 && topicsToday < maxNewTopicsPerDay) {
      const topic = nextAvailableTopic(
        input.courses,
        unfinishedCourses,
        doneConcepts,
        spentByCourse,
      );
      if (!topic) break;
      topicsToday += 1;
      const spent = spendOnTopic(
        topic.conceptId,
        topic.courseId,
        remainingXp,
        xpPerTopic,
        progressByConcept,
        doneConcepts,
        spentByCourse,
      );
      remainingXp -= spent.xp;
      if (!spent.completed) {
        partialTopic = { conceptId: topic.conceptId, courseId: topic.courseId };
        break;
      }
    }

    if (topicsToday === 0) break;
    const date = addLocalDays(input.today, day);
    for (const course of input.courses) {
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
  const overall =
    dates.length === 0 || nonNullDates.length !== dates.length
      ? null
      : (nonNullDates.at(-1) ?? null);
  return { byCourse, overall };
}

function nextAvailableTopic(
  courses: ProjectionCourse[],
  unfinishedCourses: ReadonlySet<string>,
  doneConcepts: ReadonlySet<string>,
  spentByCourse: ReadonlyMap<string, number>,
) {
  let selected: { conceptId: string; courseId: string; xpSpent: number } | undefined;
  courses.forEach((course) => {
    if (!unfinishedCourses.has(course.id)) return;
    const topic = course.topics.find(
      (candidate) =>
        !doneConcepts.has(candidate.conceptId) &&
        candidate.hardPrereqIds.every((prereqId) => doneConcepts.has(prereqId)),
    );
    if (!topic) return;
    const xpSpent = spentByCourse.get(course.id) ?? 0;
    if (!selected || xpSpent < selected.xpSpent) {
      selected = { conceptId: topic.conceptId, courseId: course.id, xpSpent };
    }
  });
  return selected;
}

function spendOnTopic(
  conceptId: string,
  courseId: string,
  availableXp: number,
  xpPerTopic: number,
  progressByConcept: Map<string, number>,
  doneConcepts: Set<string>,
  spentByCourse: Map<string, number>,
) {
  const alreadySpent = progressByConcept.get(conceptId) ?? 0;
  const neededXp = Math.max(0, xpPerTopic - alreadySpent);
  const xp = Math.min(availableXp, neededXp);
  const progress = alreadySpent + xp;
  spentByCourse.set(courseId, (spentByCourse.get(courseId) ?? 0) + xp);
  if (progress >= xpPerTopic) {
    progressByConcept.delete(conceptId);
    doneConcepts.add(conceptId);
    return { xp, completed: true };
  }
  progressByConcept.set(conceptId, progress);
  return { xp, completed: false };
}

function addLocalDays(localDate: string, days: number): string {
  const date = new Date(`${localDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
