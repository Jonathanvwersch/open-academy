import type { LessonPrerequisite } from '@academy/contracts/lessons';
import { contentVersion } from './hash.js';
import type { Dimension, ExerciseRole } from './schemas.js';
import type {
  ContentIndex,
  ContentSourceData,
  IndexedCourse,
  IndexedExercise,
  IndexedPaper,
} from './types.js';

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
  const lessonRecap = index.lessonsByConcept.get(conceptId)?.recap;
  return concept.prereqs.flatMap(({ id }) => {
    const prerequisite = index.conceptsById.get(id);
    const prerequisiteLesson = index.lessonsByConcept.get(id);
    const recap = lessonRecap?.find((entry) => entry.concept === id)?.text;
    return prerequisite && prerequisiteLesson
      ? [
          {
            id,
            title: prerequisite.title,
            ...(recap === undefined ? {} : { recap }),
          },
        ]
      : [];
  });
}

export function buildContentIndex(data: ContentSourceData): ContentIndex {
  const courses: IndexedCourse[] = data.courses.map(({ value }) => ({
    ...value,
    contentVersion: contentVersion(value),
  }));
  const coursesById = new Map(courses.map((course) => [course.id, course]));
  const orderedCourses = (data.curriculum?.value.courses ?? []).flatMap((courseId) => {
    const course = coursesById.get(courseId);
    return course ? [course] : [];
  });
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

  return {
    curriculum: data.curriculum
      ? { ...data.curriculum.value, contentVersion: contentVersion(data.curriculum.value) }
      : undefined,
    courses: orderedCourses,
    coursesById,
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
    projects,
    projectsById,
    papers,
    papersById,
  };
}
