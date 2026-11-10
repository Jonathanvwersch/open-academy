import { contentVersion } from './hash.js';
import type { Dimension, ExerciseRole, LessonPrerequisite } from './schemas.js';
import type { ContentIndex, ContentSourceData, IndexedExercise, IndexedPaper } from './types.js';

function appendToMap<Key, Value>(map: Map<Key, Value[]>, key: Key, value: Value) {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

export function getLessonPrerequisites(
  index: ContentIndex,
  conceptId: string,
): LessonPrerequisite[] {
  const concept = index.conceptsById.get(conceptId);
  if (!concept) return [];
  return concept.prereqs.flatMap(({ id }) => {
    const prerequisite = index.conceptsById.get(id);
    return prerequisite && index.lessonsByConcept.has(id)
      ? [{ id, title: prerequisite.title }]
      : [];
  });
}

export function buildContentIndex(data: ContentSourceData): ContentIndex {
  const concepts = data.concepts.map(({ value, domain }) => ({
    ...value,
    domain,
    contentVersion: contentVersion({ ...value, domain }),
  }));
  const conceptsById = new Map(concepts.map((concept) => [concept.id, concept]));
  const edges = concepts.flatMap((concept) =>
    concept.prereqs.map((prerequisite) => ({
      conceptId: concept.id,
      prerequisiteId: prerequisite.id,
      strength: prerequisite.strength,
    })),
  );

  const exercises: IndexedExercise[] = data.exercises.map(({ value, concept }) => ({
    ...value,
    concept,
    contentVersion: contentVersion({ ...value, concept }),
  }));
  const exercisesById = new Map(exercises.map((exercise) => [exercise.id, exercise]));
  const exercisesByConcept = new Map<string, IndexedExercise[]>();
  const exercisesByDimension = new Map<Dimension, IndexedExercise[]>();
  const exercisesByRole = new Map<ExerciseRole, IndexedExercise[]>();

  for (const exercise of exercises) {
    appendToMap(exercisesByConcept, exercise.concept, exercise);
    appendToMap(exercisesByDimension, exercise.dimension, exercise);
    appendToMap(exercisesByRole, exercise.role, exercise);
  }

  const lessons = data.lessons.map(({ value }) => ({
    ...value,
    contentVersion: contentVersion(value),
  }));
  const lessonsByConcept = new Map(lessons.map((lesson) => [lesson.concept, lesson]));
  const projects = data.projects.map(({ value }) => ({
    ...value,
    contentVersion: contentVersion(value),
  }));
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const papers: IndexedPaper[] = data.papers.map(({ value }) => ({
    ...value,
    contentVersion: contentVersion(value),
  }));
  const papersById = new Map(papers.map((paper) => [paper.id, paper]));
  const papersByWeek = new Map<number, IndexedPaper[]>();
  for (const paper of papers) appendToMap(papersByWeek, paper.week, paper);

  return {
    curriculum: data.curriculum
      ? { ...data.curriculum.value, contentVersion: contentVersion(data.curriculum.value) }
      : undefined,
    concepts,
    conceptsById,
    edges,
    exercises,
    exercisesById,
    exercisesByConcept,
    exercisesByDimension,
    exercisesByRole,
    lessons,
    lessonsByConcept,
    diagnostic: data.diagnostic?.value,
    projects,
    projectsById,
    papers,
    papersById,
    papersByWeek,
  };
}
