import { useEffect, useSyncExternalStore } from 'react';

let currentCourseId: string | null = null;
const listeners = new Set<() => void>();
function setCurrentCourseId(id: string | null) {
  currentCourseId = id;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useCurrentCourseId() {
  return useSyncExternalStore(
    subscribe,
    () => currentCourseId,
    () => null,
  );
}
export function useReportCurrentCourse(courseId: string | null) {
  useEffect(() => {
    setCurrentCourseId(courseId);
    return () => setCurrentCourseId(null);
  }, [courseId]);
}
