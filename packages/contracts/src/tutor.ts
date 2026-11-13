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
  messages: Array<{ id: string; role: string; content: string; createdAt: string }>;
}
