import type { StreakPayload } from './progress.js';
import type { TodayPayload } from './sessions.js';

export type CourseEnrollmentStatus = 'active' | 'paused' | 'completed';

export type CourseTopicStatus = CourseTopic['status'];

export interface StudyMapPayload {
  groups: Array<{ id: string; title: string; kind: 'course' | 'foundations' }>;
  nodes: Array<{
    id: string;
    title: string;
    groupId: string;
    status: CourseTopicStatus;
    placedOut: boolean;
    lessonAvailable: boolean;
    missingPrereqTitles: string[];
  }>;
  edges: Array<{ from: string; to: string }>;
}

export interface CourseCatalogPayload {
  subjects: Array<{
    title: string;
    courses: Array<{
      id: string;
      title: string;
      description: string;
      topicsDone: number;
      topicsTotal: number;
      status: 'not_started' | CourseEnrollmentStatus;
      startNeeded: boolean;
    }>;
  }>;
}

export interface LearnPayload {
  streak: StreakPayload;
  today: Pick<TodayPayload, 'needsCourseChoice' | 'courseStart' | 'sessionKind' | 'studyCourses'>;
  xp: {
    total: number;
    today: number;
    goal: number;
    week: Array<{ date: string; xp: number; goal: number }>;
  };
  course: {
    title: string;
    percentComplete: number;
    topicsDone: number;
    topicsTotal: number;
    estimatedFinish: string | null;
    estimatedFinishAtGoal: string | null;
  };
  studyCourses: Array<{
    id: string;
    title: string;
    topicsDone: number;
    topicsTotal: number;
    unitTitle: string;
    estimatedFinish?: string | null;
    estimatedFinishAtGoal: string | null;
  }>;
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
  course: { id: string; title: string; description: string };
  courseStart: { courseId: string | null; needed: boolean; placementRunId: string | null };
  courses: Array<{
    id: string;
    title: string;
    description: string;
    topicsDone: number;
    topicsTotal: number;
    active: boolean;
    started: boolean;
  }>;
  currentUnit: number;
  foundations: CourseTopic[];
  units: Array<{
    unit: number;
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
    topics: CourseTopic[];
  }>;
}

export type CourseDetailPayload = CoursePayload & {
  status: 'not_started' | CourseEnrollmentStatus;
  suggestedNext: Array<{ id: string; title: string; reason: string }>;
};

export interface CourseTopic {
  number: string;
  conceptId: string;
  title: string;
  hasLesson: boolean;
  status: 'locked' | 'not_started' | 'in_progress' | 'quiz' | 'complete';
  placedOut: boolean;
  mastery: 'Not started' | 'Attempted' | 'Familiar' | 'Proficient' | 'Mastered';
  needs?: Array<{ id: string; title: string; quiz?: boolean }>;
  buildsOn: Array<{ id: string; title: string }>;
  leadsTo: Array<{ id: string; title: string }>;
  leadsToMore: number;
}
