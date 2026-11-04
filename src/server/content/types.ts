import type {
  Concept,
  Curriculum,
  Diagnostic,
  Dimension,
  Exercise,
  ExerciseRole,
  Lesson,
  NotationRegistry,
  Project,
} from './schemas.js';

export interface ContentIssue {
  file: string;
  id: string;
  message: string;
}

export interface ContentSourceData {
  curriculum?: { value: Curriculum; file: string };
  concepts: Array<{ value: Concept; domain: string; file: string }>;
  lessons: Array<{ value: Lesson; file: string }>;
  exercises: Array<{ value: Exercise; concept: string; file: string }>;
  notation?: { value: NotationRegistry; file: string };
  diagnostic?: { value: Diagnostic; file: string };
  projects: Array<{ value: Project; file: string }>;
}

export type IndexedConcept = Concept & {
  domain: string;
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

export interface ContentEdge {
  conceptId: string;
  prerequisiteId: string;
  strength: 'hard' | 'soft';
}

export interface ContentIndex {
  curriculum?: Curriculum & { contentVersion: string };
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
  diagnostic?: Diagnostic;
  projects: IndexedProject[];
  projectsById: Map<string, IndexedProject>;
}
