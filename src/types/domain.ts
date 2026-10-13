/**
 * Enumerations shared with the frontend (`frontend/src/types/domain.ts`).
 * Values must stay identical: the UI switches on these exact strings.
 */

export const ROLES = ["ADMIN", "CEO", "MANAGING_DIRECTOR", "PROJECT_MANAGER", "DEPARTMENT_HEAD", "EMPLOYEE"] as const;
export type Role = (typeof ROLES)[number];

export const USER_STATUSES = ["ACTIVE", "INACTIVE", "SUSPENDED"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const PROJECT_STATUSES = ["PLANNING", "ACTIVE", "QA_TESTING", "ON_HOLD", "AT_RISK", "COMPLETED", "CANCELLED"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_TYPES = ["INTERNAL", "EXTERNAL"] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_RANK: Record<Priority, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, URGENT: 3 };

/** IN_QA: passed code review, waiting for the project's QA to pass it or report bugs. */
export const TASK_STATUSES = ["WAITING", "TODO", "IN_PROGRESS", "BLOCKED", "COMPLETED", "IN_REVIEW", "IN_QA", "TESTED", "CHANGES_REQUESTED", "APPROVED"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
/** Statuses that count as finished work for progress/overdue. */
/** TESTED: QA finished testing (a stage subtask that passed, or a stage whose subtasks QA has all tested). */
export const DONE_STATUSES: readonly TaskStatus[] = ["COMPLETED", "TESTED", "APPROVED"];

/** Staged project workflow: Design → Frontend + Backend → QA → Bug fixing, with PM approval between stages. */
export const WORKFLOW_STAGES = ["DESIGN", "FRONTEND", "BACKEND", "QA", "BUG_FIXING"] as const;
export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];
/** Work stages whose status follows their subtasks (In review → Completed → Testing → Tested). */
export const ROLLUP_STAGES: readonly WorkflowStage[] = ["DESIGN", "FRONTEND", "BACKEND"];

/** QA's verdict on a stage subtask in the current testing round. */
export const QA_RESULTS = ["PASSED", "BUGS"] as const;
export type QaResult = (typeof QA_RESULTS)[number];

/** What QA found: each reported item becomes a subtask for the developer. */
export const QA_ISSUE_KINDS = ["BUG", "DEFECT", "ISSUE", "UI", "PERFORMANCE", "SECURITY", "IMPROVEMENT"] as const;
export type QaIssueKind = (typeof QA_ISSUE_KINDS)[number];
export const QA_ISSUE_LABELS: Record<QaIssueKind, string> = {
  BUG: "Bug",
  DEFECT: "Defect",
  ISSUE: "Issue",
  UI: "UI/UX",
  PERFORMANCE: "Performance",
  SECURITY: "Security",
  IMPROVEMENT: "Improvement",
};

export const TASK_TYPES = ["FEATURE", "BUG", "DESIGN", "CONTENT", "CAMPAIGN", "TEST", "RESEARCH", "MEETING", "OPERATIONS", "OTHER"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const REVIEW_DECISIONS = ["SUBMITTED", "APPROVED", "CHANGES_REQUESTED", "QA_PASSED", "QA_FAILED"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const MILESTONE_STATUSES = ["PENDING", "IN_PROGRESS", "COMPLETED", "MISSED"] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export const CLIENT_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export const ENTITY_TYPES = ["PROJECT", "TASK", "MILESTONE", "USER", "CLIENT", "DEPARTMENT", "COMMENT", "MEETING"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const NOTIFICATION_TYPES = [
  "TASK_ASSIGNED",
  "REVIEW_REQUESTED",
  "TASK_APPROVED",
  "CHANGES_REQUESTED",
  "DEADLINE_APPROACHING",
  "MENTION",
  "PROJECT_UPDATE",
  "MEETING_INVITE",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** What a project link points to, from its URL: Figma designs, GitHub code, or anything else. */
export const PROJECT_LINK_KINDS = ["FIGMA", "GITHUB", "OTHER"] as const;
export type ProjectLinkKind = (typeof PROJECT_LINK_KINDS)[number];

export const MEETING_PLATFORMS = ["ZOOM", "GOOGLE_MEET", "TEAMS", "OTHER"] as const;
export type MeetingPlatform = (typeof MEETING_PLATFORMS)[number];
