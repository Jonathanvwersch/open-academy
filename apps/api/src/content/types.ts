import type {
  Concept,
  Course,
  Curriculum,
  Dimension,
  Exercise,
  ExerciseRole,
  Lesson,
  NotationRegistry,
  Paper,
  Project,
  SourceIndex,
} from './schemas.js';

export interface ContentIssue {
  file: string;
  id: string;
  message: string;
}

export interface ContentSourceData {
  curriculum?: { value: Curriculum; file: string };
  courses: Array<{ value: Course; file: string }>;
  concepts: Array<{ value: Concept; domain: string; file: string }>;
  lessons: Array<{ value: Lesson; file: string }>;
  exercises: Array<{ value: Exercise; concept: string; file: string }>;
  notation?: { value: NotationRegistry; file: string };
  sourceIndex?: { value: SourceIndex; file: string };
  projects: Array<{ value: Project; file: string }>;
  papers: Array<{ value: Paper; file: string }>;
}

export type IndexedConcept = Concept & {
  domain: string;
  contentVersion: string;
};

export type IndexedCourse = Course & {
  contentVersion: string;
};

export type IndexedExercise = Exercise & {
  concept: string;
  contentVersion: string;
};

export type IndexedLesson = Lesson & {
  contentVersion: string;
};

export type IndexedProject = Project & {
  contentVersion: string;
};

export type IndexedPaper = Paper & {
  contentVersion: string;
};

export interface ContentEdge {
  conceptId: string;
  prerequisiteId: string;
  strength: 'hard' | 'soft';
}

export interface ContentIndex {
  curriculum?: Curriculum & { contentVersion: string };
  subjectsByCourseId: Map<string, { id: string; title: string }>;
  courses: IndexedCourse[];
  coursesById: Map<string, IndexedCourse>;
  concepts: IndexedConcept[];
  conceptsById: Map<string, IndexedConcept>;
  edges: ContentEdge[];
  exercises: IndexedExercise[];
  exercisesById: Map<string, IndexedExercise>;
  exercisesByConcept: Map<string, IndexedExercise[]>;
  exercisesByDimension: Map<Dimension, IndexedExercise[]>;
  exercisesByRole: Map<ExerciseRole, IndexedExercise[]>;
  lessons: IndexedLesson[];
  lessonsByConcept: Map<string, IndexedLesson>;
  projects: IndexedProject[];
  projectsById: Map<string, IndexedProject>;
  papers: IndexedPaper[];
  papersById: Map<string, IndexedPaper>;
  sourceIndex?: SourceIndex;
}
