import type { TaskType, WorkflowStage } from "../types/domain";

/**
 * The staged project workflow. Each stage is a task assigned to one person and
 * reviewed by the project manager; approving a stage opens the next level:
 * Design → Frontend + Backend (in parallel) → QA → Bug fixing (only when QA
 * reports bugs, after which QA retests).
 */
export const STAGE_META: Record<WorkflowStage, { title: string; role: string; type: TaskType; level: number; description: string }> = {
  DESIGN: {
    title: "Design",
    role: "designer",
    type: "DESIGN",
    level: 0,
    description: "Design the screens and flows. Send it for review when ready; development starts once the project manager approves it.",
  },
  FRONTEND: {
    title: "Frontend development",
    role: "frontend developer",
    type: "FEATURE",
    level: 1,
    description: "Build the frontend from the approved design, then send it to the project manager for review.",
  },
  BACKEND: {
    title: "Backend development",
    role: "backend developer",
    type: "FEATURE",
    level: 1,
    description: "Build the backend and APIs, then send it to the project manager for review.",
  },
  QA: {
    title: "QA testing",
    role: "QA",
    type: "TEST",
    level: 2,
    description: "Test the approved build. Pass it, or report bugs: they go to the Bug fixing stage and you retest once the fixes are approved.",
  },
  BUG_FIXING: {
    title: "Bug fixing",
    role: "bug fixer",
    type: "BUG",
    level: 3,
    description: "Fix the bugs QA reported (each is a subtask). When all are done, send this for review; after approval it goes back to QA.",
  },
};

export const stageTitle = (stage: WorkflowStage, projectName: string) => `${STAGE_META[stage].title} · ${projectName}`;
