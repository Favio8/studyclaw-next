import { useAppStore } from "@/src/store/useAppStore";

/** Course IDs are folder basenames, so paths and activation generations matter. */
export function captureCourseScope() {
  const { workspacePath, activeCourseId, courseGeneration } = useAppStore.getState();
  return {
    courseId: activeCourseId,
    workspacePath,
    key: JSON.stringify([workspacePath, activeCourseId, courseGeneration]),
    isCurrent: () => {
      const current = useAppStore.getState();
      return current.workspacePath === workspacePath && current.activeCourseId === activeCourseId
        && current.courseGeneration === courseGeneration;
    },
  };
}
