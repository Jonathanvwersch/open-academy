import type { ContentIndex } from '../../content/types.js';
import type { LearnerRepository } from '../../db/repository.js';
import type { lessonRuns } from '../../db/schema.js';
import { lowestMasteryState, masteryLabel, topicStatus } from '../../learning/course-status.js';
import {
  compareOutlinePosition,
  masteryKey,
  prerequisiteMet,
} from '../../learning/prerequisites.js';
export function buildCourseWeeks(
  index: ContentIndex,
  masteryRecords: Awaited<ReturnType<LearnerRepository['masteryRecords']>>,
  runs: Array<typeof lessonRuns.$inferSelect>,
  paperStatuses: Map<string, 'not_started' | 'reading' | 'completed'> = new Map(),
  projectStatuses: Map<string, 'not_started' | 'in_progress' | 'completed'> = new Map(),
) {
  const masteryByConcept = new Map<string, typeof masteryRecords>();
  for (const record of masteryRecords) {
    const records = masteryByConcept.get(record.conceptId) ?? [];
    records.push(record);
    masteryByConcept.set(record.conceptId, records);
  }
  const runsByConcept = new Map(runs.map((run) => [run.conceptId, run]));
  const masteryByKey = new Map(
    masteryRecords.map((record) => [masteryKey(record.conceptId, record.dimension), record]),
  );
  const lessonRunState = runs.map(({ conceptId, status }) => ({ conceptId, status }));
  const outlineConceptIds = Array.from(
    new Set((index.curriculum?.weeks ?? []).flatMap((week) => week.concepts)),
  );
  const outlineConcepts = outlineConceptIds.flatMap((conceptId) => {
    const concept = index.conceptsById.get(conceptId);
    return concept ? [concept] : [];
  });
  return (index.curriculum?.weeks ?? [])
    .slice()
    .sort((left, right) => left.week - right.week)
    .map((week) => {
      const project = week.project ? index.projectsById.get(week.project) : undefined;
      return {
        week: week.week,
        title: week.title,
        intro: week.intro ?? '',
        project: project
          ? {
              id: project.id,
              title: project.title,
              available: project.status === 'authored' && project.tests.length > 0,
              status: projectStatuses.get(project.id) ?? 'not_started',
            }
          : null,
        papers: (index.papersByWeek.get(week.week) ?? []).map((paper) => ({
          id: paper.id,
          title: paper.title,
          authors: paper.authors,
          year: paper.year,
          estMinutes: paper.est_minutes,
          status: paperStatuses.get(paper.id) ?? 'not_started',
        })),
        topics: week.concepts.map((conceptId, indexInWeek) => {
          const concept = index.conceptsById.get(conceptId);
          if (!concept) {
            return {
              number: `${week.week}.${indexInWeek + 1}`,
              conceptId,
              title: conceptId,
              hasLesson: false,
              status: 'not_started' as const,
              mastery: 'Not started',
              buildsOn: [],
              leadsTo: [],
              leadsToMore: 0,
            };
          }
          const records = masteryByConcept.get(concept.id) ?? [];
          const dimensionStates = concept.dimensions.map(
            (dimension) =>
              records.find((record) => record.dimension === dimension)?.state ?? 'not_assessed',
          );
          const runStatus = runsByConcept.get(concept.id)?.status;
          const status = topicStatus({
            lessonRunStatus: runStatus,
            dimensionStates,
            prerequisites: concept.prereqs.map((prerequisite) => ({
              strength: prerequisite.strength,
              done: prerequisiteMet(prerequisite.id, masteryByKey, lessonRunState, index),
            })),
          });
          const needs = concept.prereqs
            .filter(
              (prerequisite) =>
                prerequisite.strength === 'hard' &&
                !prerequisiteMet(prerequisite.id, masteryByKey, lessonRunState, index),
            )
            .sort((left, right) => compareOutlinePosition(left.id, right.id, index))
            .map((prerequisite) => ({
              id: prerequisite.id,
              title: index.conceptsById.get(prerequisite.id)?.title ?? prerequisite.id,
              ...(runsByConcept.get(prerequisite.id)?.status === 'quiz' ? { quiz: true } : {}),
            }));
          const buildsOn = [...concept.prereqs]
            .sort((left, right) => compareOutlinePosition(left.id, right.id, index))
            .map((prerequisite) => ({
              id: prerequisite.id,
              title: index.conceptsById.get(prerequisite.id)?.title ?? prerequisite.id,
            }));
          const nextConcepts = outlineConcepts.filter((candidate) =>
            candidate.prereqs.some((prerequisite) => prerequisite.id === concept.id),
          );
          return {
            number: `${week.week}.${indexInWeek + 1}`,
            conceptId,
            title: concept.title,
            hasLesson: index.lessonsByConcept.has(concept.id),
            status,
            mastery: masteryLabel(lowestMasteryState(dimensionStates)),
            buildsOn,
            leadsTo: nextConcepts.slice(0, 3).map((candidate) => ({
              id: candidate.id,
              title: candidate.title,
            })),
            leadsToMore: Math.max(0, nextConcepts.length - 3),
            ...(status === 'locked' ? { needs } : {}),
          };
        }),
      };
    });
}
