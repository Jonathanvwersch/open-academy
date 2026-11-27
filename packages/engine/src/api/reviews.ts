export interface ReviewsPayload {
  dueNow: number;
  upcoming: Array<{ date: string; count: number }>;
  topics: ReviewTopic[];
}

export interface ReviewTopic {
  conceptId: string;
  title: string;
  courseId: string | null;
  courseTitle: string | null;
  kinds: string[];
  dueAt: string;
  due: boolean;
  dueInDays: number;
}
