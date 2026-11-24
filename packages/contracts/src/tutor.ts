export const tutorLessonStages = ['step', 'explain', 'quiz'] as const;
export type TutorLessonStage = (typeof tutorLessonStages)[number];

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
