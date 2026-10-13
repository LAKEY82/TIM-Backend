import { z } from "zod";
import { PRIORITIES, PROJECT_STATUSES, PROJECT_TYPES } from "../types/domain";
import { dateInput, objectId, optionalText, paginationQuery, sortOrder } from "./common";

export const listProjectsQuery = z
  .object({
    search: z.string().max(100).optional(),
    status: z.enum(PROJECT_STATUSES).optional(),
    clientId: objectId.optional(),
    managerId: objectId.optional(),
    memberId: objectId.optional(),
    /** Projects the user tests as QA (the project's QA, or the tester of any of its tasks). */
    qaId: z.union([z.literal("me"), objectId]).optional(),
    departmentId: objectId.optional(),
    sortBy: z.enum(["name", "deadline", "progress", "createdAt"]).default("createdAt"),
    sortOrder: sortOrder,
  })
  .and(paginationQuery(200));

const projectFields = {
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(150),
  description: optionalText(10000),
  clientId: objectId.nullable().optional(),
  type: z.enum(PROJECT_TYPES),
  status: z.enum(PROJECT_STATUSES),
  priority: z.enum(PRIORITIES),
  startDate: dateInput,
  designLink: z.string().trim().max(1000).nullable().default(null),
  githubLink: z.string().trim().max(1000).nullable().default(null),
  deadline: dateInput,
  managerId: objectId.nullable().optional(),
  qaId: objectId,
  memberIds: z.array(objectId).max(200),
  departmentId: objectId.nullable().optional(),
  estimatedHours: z.number().min(0).max(100000).nullable().optional(),
};

function checkDates<T extends { startDate?: Date | null; deadline?: Date | null }>(v: T, ctx: z.RefinementCtx) {
  if (v.startDate && v.deadline && v.deadline < v.startDate) {
    ctx.addIssue({ code: "custom", path: ["deadline"], message: "Deadline can't be before the start date." });
  }
}

/** Who does each stage. Design, Frontend and Backend are created only when someone is named. */
const workflowPeople = {
  designerId: objectId.nullable().optional(),
  frontendId: objectId.nullable().optional(),
  backendId: objectId.nullable().optional(),
  /** Defaults to the frontend developer, then the backend developer. */
  bugFixerId: objectId.nullable().optional(),
};
const NEEDS_PEOPLE = "Assign at least a designer or a developer.";
const hasPeople = (w: { designerId?: string | null; frontendId?: string | null; backendId?: string | null }) => Boolean(w.designerId || w.frontendId || w.backendId);

export const setupWorkflowSchema = z
  .object({ ...workflowPeople, qaId: objectId.optional() })
  .strict()
  .refine(hasPeople, { path: ["workflow"], message: NEEDS_PEOPLE });
export type WorkflowInput = z.output<typeof setupWorkflowSchema>;

export const createProjectSchema = z
  .object({
    ...projectFields,
    type: projectFields.type.default("EXTERNAL"),
    status: projectFields.status.default("PLANNING"),
    priority: projectFields.priority.default("MEDIUM"),
    memberIds: projectFields.memberIds.default([]),
    qaId: objectId.optional(),
    /** Break the project into workflow stages on creation. */
    workflow: z.object(workflowPeople).strict().optional(),
  })
  .superRefine((v, ctx) => {
    checkDates(v, ctx);
    if (v.workflow && !hasPeople(v.workflow)) ctx.addIssue({ code: "custom", path: ["workflow"], message: NEEDS_PEOPLE });
    // Every new project must have a QA person who tests tasks after code review.
    if (!v.qaId) ctx.addIssue({ code: "custom", path: ["qaId"], message: "Assign a QA person for this project." });
    if (v.type === "EXTERNAL" && !v.clientId) ctx.addIssue({ code: "custom", path: ["clientId"], message: "External projects need a client." });
  });

export const updateProjectSchema = z.object(projectFields).partial().strict().superRefine(checkDates);

export const addMemberSchema = z.object({ userId: objectId });
