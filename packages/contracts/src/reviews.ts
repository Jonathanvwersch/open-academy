export interface ReviewsPayload {
  dueNow: number;
  upcoming: Array<{ date: string; count: number }>;
  topics: Array<{
    conceptId: string;
    title: string;
    dimension: string;
    dueAt: string;
    due: boolean;
    dueInDays: number;
    lastReviewAt: string | null;
    reps: number;
    lapses: number;
    recall: number;
  }>;
}
