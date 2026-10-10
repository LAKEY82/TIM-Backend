import { z } from "zod";
import { PRIORITIES, TASK_STATUSES, TASK_TYPES, QA_ISSUE_KINDS } from "../types/domain";
import { dateInput, dayString, objectId, oneOrMany, optionalText, paginationQuery, queryBool, sortOrder } from "./common";

const meOrId = z.union([z.literal("me"), objectId]);

export const listTasksQuery = z
  .object({
    search: z.string().max(100).optional(),
    projectId: objectId.optional(),
    milestoneId: objectId.optional(),
    parentId: objectId.optional(),
    assigneeId: meOrId.optional(),
    reviewerId: meOrId.optional(),
    qaId: meOrId.optional(),
    /** Only work in review that's waiting for me (as reviewer, or as PM when it has no reviewer). */
    awaitingReview: queryBool,
    /** With assigneeId=me: also include work waiting for my review. */
    includeReviews: queryBool,
    /** With assigneeId=me: also include tasks waiting for me to QA test them. */
    includeQa: queryBool,
    /** "My bugs": issues I test or reported as QA. */
    qaBugs: queryBool,
    /** The bugs QA reported on a task (for the workflow's QA stage: the ones under Bug fixing). */
    issuesOf: objectId.optional(),
    /** With assigneeId=me: leave out bugs on my own tasks (they're listed under those tasks instead). */
    nestIssues: queryBool,
    departmentId: objectId.optional(),
    status: oneOrMany(z.enum(TASK_STATUSES)),
    priority: z.enum(PRIORITIES).optional(),
    overdue: queryBool,
    dueFrom: dayString.optional(),
    dueTo: dayString.optional(),
    sortBy: z.enum(["title", "dueDate", "qaDueDate", "priority", "status", "estimatedHours", "actualHours", "createdAt"]).default("createdAt"),
    sortOrder: sortOrder,
  })
  // Boards and calendars render a whole project at once, hence the higher cap.
  .and(paginationQuery(500));

const tags = z.array(z.string().trim().min(1).max(40)).max(20);

function checkDates(v: { startDate?: Date | null; dueDate?: Date | null }, ctx: z.RefinementCtx) {
  if (v.startDate && v.dueDate && v.dueDate < v.startDate) {
    ctx.addIssue({ code: "custom", path: ["dueDate"], message: "Due date can't be before the start date." });
  }
}

export const createTaskSchema = z
  .object({
    title: z.string().trim().min(3, "Title must be at least 3 characters.").max(200),
    description: optionalText(10000),
    projectId: objectId,
    milestoneId: objectId.nullable().optional(),
    assigneeId: objectId.nullable().optional(),
    reviewerId: objectId.nullable().optional(),
    departmentId: objectId.nullable().optional(),
    parentId: objectId.nullable().optional(),
    priority: z.enum(PRIORITIES).default("MEDIUM"),
    type: z.enum(TASK_TYPES).default("OTHER"),
    startDate: dateInput,
    dueDate: dateInput,
    estimatedHours: z.number().min(0).max(1000).nullable().optional(),
    tags: tags.default([]),
  })
  .superRefine((v, ctx) => {
    checkDates(v, ctx);
    if (v.assigneeId && v.reviewerId && v.assigneeId === v.reviewerId) {
      ctx.addIssue({ code: "custom", path: ["reviewerId"], message: "The reviewer should be someone other than the assignee." });
    }
  });

export const updateTaskSchema = z
  .object({
    title: z.string().trim().min(3, "Title must be at least 3 characters.").max(200),
    description: optionalText(10000),
    milestoneId: objectId.nullable(),
    assigneeId: objectId.nullable(),
    reviewerId: objectId.nullable(),
    departmentId: objectId.nullable(),
    priority: z.enum(PRIORITIES),
    type: z.enum(TASK_TYPES),
    startDate: dateInput,
    dueDate: dateInput,
    qaDueDate: dateInput,
    /** QA tester for this task (the PM picks who tests it). */
    qaId: objectId.nullable(),
    estimatedHours: z.number().min(0).max(1000).nullable(),
    actualHours: z.number().min(0).max(10000).nullable(),
    tags,
    /** The QA report on a bug (only valid on issues QA reported). */
    qaIssue: z
      .object({
        kind: z.enum(QA_ISSUE_KINDS),
        steps: optionalText(5000),
        expected: optionalText(2000),
        actual: optionalText(2000),
        environment: optionalText(300),
      })
      .partial(),
  })
  .partial()
  .superRefine(checkDates);

export const statusSchema = z.object({ status: z.enum(TASK_STATUSES) });
export const submitSchema = z.object({ note: z.string().trim().max(4000).optional() });
export const approveSchema = z.object({ feedback: z.string().trim().max(4000).optional() });
export const requestChangesSchema = z.object({
  feedback: z.string().trim().min(5, "Describe what needs to change (at least 5 characters).").max(4000),
});
export const myDayQuery = z.object({ date: dayString.optional() });

export const commentSchema = z.object({
  body: z.string().trim().min(1, "Write something first.").max(10000),
  mentionIds: z.array(objectId).max(50).default([]),
});

export const qaPassSchema = z.object({ note: z.string().trim().max(4000).optional() });

export const qaCompleteSchema = z.object({ note: z.string().trim().max(4000).optional() });

export const qaFailSchema = z.object({
  bugs: z
    .array(
      z.object({
        kind: z.enum(QA_ISSUE_KINDS).default("BUG"),
        title: z.string().trim().min(3, "Describe the bug in at least 3 characters.").max(200),
        steps: z.string().trim().max(5000).nullish().transform((v) => v || null),
        expected: z.string().trim().max(2000).nullish().transform((v) => v || null),
        actual: z.string().trim().max(2000).nullish().transform((v) => v || null),
        environment: z.string().trim().max(300).nullish().transform((v) => v || null),
        description: z
          .string()
          .trim()
          .max(5000)
          .nullish()
          .transform((v) => v || null),
        priority: z.enum(PRIORITIES).default("HIGH"),
        /** When the developer should have it fixed. */
        dueDate: dateInput,
      }),
    )
    .min(1, "Report at least one bug.")
    .max(30),
  note: z.string().trim().max(4000).optional(),
});
