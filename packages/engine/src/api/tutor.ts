export const tutorLessonStages = ['step', 'explain', 'quiz'] as const;
export type TutorLessonStage = (typeof tutorLessonStages)[number];

export type TutorContextInput = {
  page?: 'session' | 'lesson' | 'course' | 'map' | 'paper';
  conceptId?: string;
  activityId?: string;
  exerciseId?: string;
  lessonProblemId?: string;
  knowledgePointId?: string;
  lessonStage?: TutorLessonStage;
  questionLabel?: string;
  paperId?: string;
  pageNumber?: number;
  selection?: string;
  threadConceptId?: string | null;
};

export type TutorPrompt = {
  conceptTitle: string;
  objectives: string[];
  lessonSummary: string;
  exercisePrompt: string;
  exerciseLabel: string;
  exerciseOptions: string[];
  answerKey: string;
  learnerAnswer?: string;
  graderVerdict?: string;
  graderFeedback: string;
  hintLevel: number;
  authoredHints: string[];
  solution: string;
  recentMistakes: string[];
  mode?: 'practice';
  problem_status: 'unanswered' | 'retrying' | 'answered' | 'none';
  page: string;
  page_content: string;
};

export type TutorTurn = {
  conceptId: string | null;
  activityId?: string;
  exerciseId?: string;
  level: 'nudge' | 'hint' | 'worked_step';
  prompt: TutorPrompt;
};

export interface CourseOutlineUnit {
  unit: number;
  title: string;
  intro?: string;
  topics: Array<{ title: string; status: string }>;
}

export interface PaperTutorContext {
  title: string;
  authors: string;
  year: number;
  whyThisWeek: string;
  questions: Array<{ kind: string; prompt: string }>;
  notes: Record<string, string>;
  summary?: string | null;
  feedback?: unknown;
  pages: Array<{ page: number; text: string }>;
}

export interface TutorStatus {
  tutorEnabled: boolean;
}

export interface TutorThreadSummary {
  id: string;
  conceptId: string | null;
  conceptTitle: string | null;
  title: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview: string;
}

export interface TutorThreadDetail {
  thread: TutorThreadSummary;
  messages: Array<{
    id: string;
    clientId: string | null;
    role: string;
    content: string;
    createdAt: string;
  }>;
}
