export interface LearnPayload {
  xp: {
    total: number;
    today: number;
    goal: number;
    week: Array<{ date: string; xp: number; goal: number }>;
  };
  course: {
    percentComplete: number;
    topicsDone: number;
    topicsTotal: number;
    estimatedFinish: string | null;
    estimatedFinishAtGoal: string | null;
  };
  tasks: Array<{
    id: string;
    activityKind: string;
    label: 'Lesson' | 'Review' | 'Practice' | 'Project' | 'Quiz';
    conceptId?: string;
    title: string;
    xp: number;
    prerequisites: Array<{ id: string; title: string; done: boolean }>;
  }>;
  choices: Array<{
    conceptId: string;
    title: string;
    xp: number;
    recommended: boolean;
  }>;
  doneToday: Array<{
    activityId: string;
    label: string;
    title: string;
    xp: number;
    completedAt: string;
  }>;
  activeSessionId: string | null;
}

export interface CoursePayload {
  currentWeek: number;
  weeks: Array<{
    week: number;
    title: string;
    intro: string;
    project: {
      id: string;
      title: string;
      available: boolean;
      status: 'not_started' | 'in_progress' | 'completed';
    } | null;
    papers: Array<{
      id: string;
      title: string;
      authors: string;
      year: number;
      estMinutes: number;
      status: 'not_started' | 'reading' | 'completed';
    }>;
    topics: Array<{
      number: string;
      conceptId: string;
      title: string;
      hasLesson: boolean;
      status: 'locked' | 'not_started' | 'in_progress' | 'quiz' | 'complete';
      mastery: 'Not started' | 'Attempted' | 'Familiar' | 'Proficient' | 'Mastered';
      needs?: Array<{ id: string; title: string; quiz?: boolean }>;
      buildsOn: Array<{ id: string; title: string }>;
      leadsTo: Array<{ id: string; title: string }>;
      leadsToMore: number;
    }>;
  }>;
}
