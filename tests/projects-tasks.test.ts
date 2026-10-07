import type { Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runQaDeadlineReminders } from "../src/jobs/deadline-reminders";
import { Activity, Notification, Project, Task } from "../src/models";
import { login, resetDb, seedFixture, startTestDb, stopTestDb, type Fixture, type Session } from "./helpers";

let app: Express;
let fx: Fixture;
let pm: Session;
let emp: Session;

beforeAll(async () => {
  app = await startTestDb();
});
afterAll(stopTestDb);
beforeEach(async () => {
  await resetDb();
  fx = await seedFixture();
  pm = await login(app, "pm@t.test");
  emp = await login(app, "emp@t.test");
});

async function createTask(overrides: Record<string, unknown> = {}) {
  const res = await pm.post("/api/tasks", {
    title: "Checkout API",
    projectId: String(fx.project),
    assigneeId: String(fx.emp),
    reviewerId: String(fx.pm),
    priority: "HIGH",
    type: "FEATURE",
    dueDate: "2030-01-15",
    estimatedHours: 6,
    tags: ["api"],
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; status: string };
}

describe("projects", () => {
  it("creates a project in the shape the frontend expects", async () => {
    const res = await pm.post("/api/projects", {
      name: "Gamma App",
      description: "",
      clientId: null,
      type: "INTERNAL",
      status: "PLANNING",
      priority: "HIGH",
      startDate: "2030-01-01",
      deadline: "2030-03-01",
      managerId: null,
      memberIds: [String(fx.emp)],
      qaId: String(fx.outsider),
      estimatedHours: 120,
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: "Gamma App",
      description: null,
      type: "INTERNAL",
      status: "PLANNING",
      startDate: "2030-01-01",
      deadline: "2030-03-01",
      progress: 0,
      taskCount: 0,
      manager: { id: String(fx.pm), name: "Pam Test" },
      members: [expect.objectContaining({ id: String(fx.emp) })],
    });
    expect(await Notification.countDocuments({ recipient: fx.emp, type: "PROJECT_UPDATE" })).toBe(1);
  });

  it("validates: external projects need a client; deadline after start", async () => {
    const res = await pm.post("/api/projects", { name: "Ext", type: "EXTERNAL", startDate: "2030-02-01", deadline: "2030-01-01" });
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e: { path: string }) => e.path).sort()).toEqual(["clientId", "deadline", "qaId"]);
  });

  it("lists with search, filter, sorting and pagination metadata", async () => {
    const ceo = await login(app, "ceo@t.test");
    for (const name of ["Delta", "Epsilon", "Zeta"]) await ceo.post("/api/projects", { name, type: "INTERNAL", status: "ACTIVE", qaId: String(fx.outsider) });
    const page1 = await ceo.get("/api/projects?sortBy=name&sortOrder=asc&page=1&pageSize=2");
    expect(page1.body.data.map((p: { name: string }) => p.name)).toEqual(["Alpha Portal", "Beta Store"]);
    expect(page1.body.meta).toMatchObject({ page: 1, pageSize: 2, limit: 2, total: 5, totalPages: 3 });
    // `limit` works as an alias for `pageSize`.
    expect((await ceo.get("/api/projects?limit=1")).body.data).toHaveLength(1);
    expect((await ceo.get("/api/projects?search=psil")).body.data.map((p: { name: string }) => p.name)).toEqual(["Epsilon"]);
    expect((await ceo.get("/api/projects?pageSize=5000")).status).toBe(400);
  });

  it("adds and removes members (manager only)", async () => {
    expect((await pm.post(`/api/projects/${fx.project}/members`, { userId: String(fx.outsider) })).status).toBe(201);
    const members = await pm.get(`/api/projects/${fx.project}/members`);
    expect(members.body.data.map((m: { id: string }) => m.id)).toContain(String(fx.outsider));
    expect((await emp.post(`/api/projects/${fx.project}/members`, { userId: String(fx.outsider) })).status).toBe(403);
    expect((await pm.del(`/api/projects/${fx.project}/members/${fx.outsider}`)).status).toBe(204);
    expect(await Activity.countDocuments({ type: { $in: ["PROJECT_MEMBER_ADDED", "PROJECT_MEMBER_REMOVED"] } })).toBe(2);
  });
});

describe("tasks", () => {
  it("creates and assigns a task: summary shape, notification, activity, project counters", async () => {
    const task = await createTask();
    expect(task).toMatchObject({
      title: "Checkout API",
      status: "TODO",
      priority: "HIGH",
      project: { id: String(fx.project), name: "Alpha Portal" },
      assignee: { id: String(fx.emp), name: "Emma Test" },
      reviewer: { id: String(fx.pm) },
      dueDate: "2030-01-15",
      estimatedHours: 6,
      tags: ["api"],
      subtasks: [],
      attachments: [],
    });
    expect(await Notification.findOne({ recipient: fx.emp, type: "TASK_ASSIGNED" })).toBeTruthy();
    expect(await Activity.findOne({ type: "TASK_ASSIGNED", "target.id": fx.emp })).toBeTruthy();
    expect((await Project.findById(fx.project).lean())!.taskCount).toBe(1);
  });

  it("rejects references outside the project and reviewer = assignee", async () => {
    const res = await pm.post("/api/tasks", { title: "Bad", projectId: String(fx.project), assigneeId: String(fx.emp), reviewerId: String(fx.emp) });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].path).toBe("reviewerId");
    const badMilestone = await pm.post("/api/tasks", { title: "Bad milestone", projectId: String(fx.project), milestoneId: "507f1f77bcf86cd799439011" });
    expect(badMilestone.status).toBe(422);
  });

  it("assignees may only log hours; managers may edit everything", async () => {
    const task = await createTask();
    expect((await emp.patch(`/api/tasks/${task.id}`, { title: "Renamed" })).status).toBe(403);
    const logged = await emp.patch(`/api/tasks/${task.id}`, { actualHours: 3.5 });
    expect(logged.status).toBe(200);
    expect(logged.body.data.actualHours).toBe(3.5);

    const reassigned = await pm.patch(`/api/tasks/${task.id}`, { assigneeId: String(fx.emp2), priority: "URGENT" });
    expect(reassigned.status).toBe(200);
    expect(reassigned.body.data).toMatchObject({ priority: "URGENT", assignee: { id: String(fx.emp2) } });
    expect(await Notification.findOne({ recipient: fx.emp2, type: "TASK_ASSIGNED" })).toBeTruthy();
  });

  it("runs the full workflow: start → submit → request changes → resubmit → approve", async () => {
    const task = await createTask();

    // Assignees can't skip ahead.
    expect((await emp.patch(`/api/tasks/${task.id}/status`, { status: "APPROVED" })).status).toBe(403);
    expect((await emp.patch(`/api/tasks/${task.id}/status`, { status: "BLOCKED" })).status).toBe(422);

    const started = await emp.patch(`/api/tasks/${task.id}/status`, { status: "IN_PROGRESS" });
    expect(started.status).toBe(200);
    expect(started.body.data.status).toBe("IN_PROGRESS");

    const submitted = await emp.post(`/api/tasks/${task.id}/submit`);
    expect(submitted.body.data.status).toBe("IN_REVIEW");
    expect(await Notification.findOne({ recipient: fx.pm, type: "REVIEW_REQUESTED" })).toBeTruthy();

    // Only the reviewer (not the assignee, not another employee) can decide.
    expect((await emp.post(`/api/tasks/${task.id}/approve`)).status).toBe(403);
    const emp2 = await login(app, "emp2@t.test");
    expect((await emp2.post(`/api/tasks/${task.id}/approve`)).status).toBe(403);

    expect((await pm.post(`/api/tasks/${task.id}/request-changes`, { feedback: "no" })).status).toBe(422);
    const changes = await pm.post(`/api/tasks/${task.id}/request-changes`, { feedback: "Handle discount rounding." });
    expect(changes.body.data.status).toBe("CHANGES_REQUESTED");
    expect(await Notification.findOne({ recipient: fx.emp, type: "CHANGES_REQUESTED", body: "Handle discount rounding." })).toBeTruthy();

    await emp.post(`/api/tasks/${task.id}/submit`, { note: "Fixed" });
    const approved = await pm.post(`/api/tasks/${task.id}/approve`);
    expect(approved.body.data.status).toBe("APPROVED");
    expect(approved.body.data.completedAt).toEqual(expect.any(String));

    const history = await emp.get(`/api/tasks/${task.id}/reviews`);
    expect(history.body.data.map((r: { decision: string }) => r.decision)).toEqual(["SUBMITTED", "CHANGES_REQUESTED", "SUBMITTED", "APPROVED"]);
    expect(history.body.data[1]).toMatchObject({ feedback: "Handle discount rounding.", actor: { id: String(fx.pm) } });

    const project = await Project.findById(fx.project).lean();
    expect(project).toMatchObject({ taskCount: 1, completedTaskCount: 1, progress: 100 });
  });

  it("an assignee can send their own To do task straight to review from the status menu", async () => {
    const task = await createTask();
    const res = await emp.patch(`/api/tasks/${task.id}/status`, { status: "IN_REVIEW" });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("IN_REVIEW");
    expect(await Notification.findOne({ recipient: fx.pm, type: "REVIEW_REQUESTED" })).toBeTruthy();
    // ...but can't approve it themselves.
    expect((await emp.patch(`/api/tasks/${task.id}/status`, { status: "APPROVED" })).status).toBe(403);
  });

  it("only the assigned developer can send a task for review (not managers or admins)", async () => {
    const task = await createTask();
    const admin = await login(app, "admin@t.test");
    expect((await pm.post(`/api/tasks/${task.id}/submit`)).status).toBe(403);
    expect((await pm.patch(`/api/tasks/${task.id}/status`, { status: "IN_REVIEW" })).status).toBe(403);
    expect((await admin.patch(`/api/tasks/${task.id}/status`, { status: "IN_REVIEW" })).status).toBe(403);
    // Managers can still move it to other statuses.
    expect((await pm.patch(`/api/tasks/${task.id}/status`, { status: "IN_PROGRESS" })).status).toBe(200);
    expect((await emp.post(`/api/tasks/${task.id}/submit`)).status).toBe(200);
  });

  it("board moves: managers can set any status; CHANGES_REQUESTED needs written feedback", async () => {
    const task = await createTask();
    expect((await pm.patch(`/api/tasks/${task.id}/status`, { status: "BLOCKED" })).body.data.status).toBe("BLOCKED");
    expect((await pm.patch(`/api/tasks/${task.id}/status`, { status: "CHANGES_REQUESTED" })).status).toBe(422);
  });

  it("filters, sorts, searches and paginates task lists", async () => {
    await createTask({ title: "Alpha low", priority: "LOW", dueDate: "2030-01-01" });
    await createTask({ title: "Beta urgent", priority: "URGENT", dueDate: "2030-01-03" });
    await createTask({ title: "Gamma medium", priority: "MEDIUM", dueDate: "2030-01-02", assigneeId: String(fx.emp2) });

    const byPriority = await pm.get(`/api/tasks?projectId=${fx.project}&sortBy=priority&sortOrder=desc`);
    expect(byPriority.body.data.map((t: { title: string }) => t.title)).toEqual(["Beta urgent", "Gamma medium", "Alpha low"]);

    const mine = await emp.get("/api/tasks?assigneeId=me");
    expect(mine.body.data).toHaveLength(2);

    const multiStatus = await pm.get("/api/tasks?status=TODO&status=IN_PROGRESS&search=gamma");
    expect(multiStatus.body.data.map((t: { title: string }) => t.title)).toEqual(["Gamma medium"]);

    const range = await pm.get("/api/tasks?dueFrom=2030-01-02&dueTo=2030-01-03&sortBy=dueDate");
    expect(range.body.data.map((t: { title: string }) => t.title)).toEqual(["Gamma medium", "Beta urgent"]);

    const paged = await pm.get("/api/tasks?pageSize=2&page=2&sortBy=title");
    expect(paged.body.meta).toMatchObject({ total: 3, page: 2, totalPages: 2 });
    expect(paged.body.data).toHaveLength(1);

    // Employees outside the project see nothing.
    const outsider = await login(app, "outsider@t.test");
    expect((await outsider.get("/api/tasks")).body.data).toHaveLength(0);
  });

  it("subtasks are tasks with a parent and roll up into counts", async () => {
    const parent = await createTask();
    await pm.post("/api/tasks", { title: "Write tests", projectId: String(fx.project), parentId: parent.id });
    const detail = await pm.get(`/api/tasks/${parent.id}`);
    expect(detail.body.data.subtasks).toEqual([expect.objectContaining({ title: "Write tests", status: "TODO" })]);
    expect(detail.body.data.subtaskCount).toBe(1);
  });

  it("My Day groups the employee's own tasks", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    const inThreeDays = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    await createTask({ title: "Due today", dueDate: today });
    await createTask({ title: "Late", dueDate: yesterday });
    await createTask({ title: "Soon", dueDate: inThreeDays });
    const res = await emp.get(`/api/tasks/my-day?date=${today}`);
    expect(res.status).toBe(200);
    const titles = (k: string) => res.body.data[k].map((t: { title: string }) => t.title);
    expect(titles("today")).toEqual(["Due today"]);
    expect(titles("overdue")).toEqual(["Late"]);
    expect(titles("upcoming")).toEqual(["Soon"]);
  });

  describe("QA stage", () => {
    async function readyForReview(qaOnProject = true) {
      if (qaOnProject) await Project.updateOne({ _id: fx.project }, { qa: fx.outsider });
      const task = await createTask();
      await emp.post(`/api/tasks/${task.id}/submit`);
      return task;
    }

    it("approving a reviewed task sends it to the project's QA, who receives it as a task", async () => {
      const task = await readyForReview();
      const approved = await pm.post(`/api/tasks/${task.id}/approve`);
      expect(approved.body.data).toMatchObject({ status: "IN_QA", qa: { id: String(fx.outsider) } });
      expect(await Notification.findOne({ recipient: fx.outsider, type: "REVIEW_REQUESTED", title: /ready for QA/ })).toBeTruthy();

      // The QA can see it (even though they aren't a project member) and it's in their queue.
      const qa = await login(app, "outsider@t.test");
      expect((await qa.get(`/api/tasks/${task.id}`)).status).toBe(200);
      const queue = await qa.get("/api/tasks?qaId=me&status=IN_QA");
      expect(queue.body.data.map((t: { id: string }) => t.id)).toEqual([task.id]);
      const day = await qa.get("/api/tasks/my-day");
      expect(day.body.data.qaQueue.map((t: { id: string }) => t.id)).toEqual([task.id]);
    });

    it("QA passes a task: it becomes Approved and the developer is told", async () => {
      const task = await readyForReview();
      await pm.post(`/api/tasks/${task.id}/approve`);
      const qa = await login(app, "outsider@t.test");
      const passed = await qa.post(`/api/tasks/${task.id}/qa/pass`, { note: "Works on all browsers." });
      expect(passed.status).toBe(200);
      expect(passed.body.data.status).toBe("APPROVED");
      expect(await Notification.findOne({ recipient: fx.emp, title: /passed QA/ })).toBeTruthy();
      const history = await pm.get(`/api/tasks/${task.id}/reviews`);
      expect(history.body.data.map((r: { decision: string }) => r.decision)).toEqual(["SUBMITTED", "APPROVED", "QA_PASSED"]);
    });

    it("QA reports bugs: bug subtasks go to the developer and the task returns to them", async () => {
      const task = await readyForReview();
      await pm.post(`/api/tasks/${task.id}/approve`);
      const qa = await login(app, "outsider@t.test");
      expect((await qa.post(`/api/tasks/${task.id}/qa/fail`, { bugs: [] })).status).toBe(422);

      const failed = await qa.post(`/api/tasks/${task.id}/qa/fail`, {
        bugs: [
          { title: "Total ignores coupon", priority: "URGENT", description: "Apply SAVE10 then checkout." },
          // The UI sends null for an empty details box.
          { title: "Button misaligned on mobile", description: null },
        ],
        note: "Two problems found.",
      });
      expect(failed.status).toBe(200);
      expect(failed.body.data.status).toBe("CHANGES_REQUESTED");
      expect(failed.body.data.subtasks).toHaveLength(2);

      const bugs = await emp.get(`/api/tasks?parentId=${task.id}`);
      expect(bugs.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ title: "Total ignores coupon", type: "BUG", priority: "URGENT", status: "TODO", assignee: expect.objectContaining({ id: String(fx.emp) }) }),
          expect.objectContaining({ title: "Button misaligned on mobile", priority: "HIGH" }),
        ]),
      );
      expect(await Notification.findOne({ recipient: fx.emp, type: "CHANGES_REQUESTED", title: /QA found 2 issues/ })).toBeTruthy();

      // The developer fixes and resubmits; it goes through review and QA again.
      expect((await emp.post(`/api/tasks/${task.id}/submit`)).body.data.status).toBe("IN_REVIEW");
      expect((await pm.post(`/api/tasks/${task.id}/approve`)).body.data.status).toBe("IN_QA");
    });

    it("only the project's QA (or a manager) can pass or fail QA, never the developer", async () => {
      const task = await readyForReview();
      await pm.post(`/api/tasks/${task.id}/approve`);
      expect((await emp.post(`/api/tasks/${task.id}/qa/pass`)).status).toBe(403);
      const emp2 = await login(app, "emp2@t.test");
      expect((await emp2.post(`/api/tasks/${task.id}/qa/pass`)).status).toBe(403);
    });

    it("the project manager can send any task to QA from the status menu; it becomes the QA's task", async () => {
      await Project.updateOne({ _id: fx.project }, { qa: fx.outsider });
      const task = await createTask({ title: "Not reviewed yet" });

      // The developer can't skip the review on their own.
      expect((await emp.patch(`/api/tasks/${task.id}/status`, { status: "IN_QA" })).status).toBe(403);

      const sent = await pm.patch(`/api/tasks/${task.id}/status`, { status: "IN_QA" });
      expect(sent.status).toBe(200);
      expect(sent.body.data).toMatchObject({ status: "IN_QA", qa: { id: String(fx.outsider) } });
      expect(await Notification.findOne({ recipient: fx.outsider, type: "REVIEW_REQUESTED", title: /sent Not reviewed yet to you for QA/ })).toBeTruthy();

      const qa = await login(app, "outsider@t.test");
      const queue = await qa.get("/api/tasks?qaId=me&status=IN_QA");
      expect(queue.body.data.map((t: { id: string }) => t.id)).toEqual([task.id]);
      expect((await qa.post(`/api/tasks/${task.id}/qa/pass`)).body.data.status).toBe("APPROVED");
    });

    it("a task sent to QA before the project has a QA goes to the QA once one is added", async () => {
      const task = await createTask({ title: "Waiting for a tester" });
      const sent = await pm.patch(`/api/tasks/${task.id}/status`, { status: "IN_QA" });
      expect(sent.body.data.status).toBe("IN_QA");
      expect(sent.body.data.qa).toBeNull();

      await pm.patch(`/api/projects/${fx.project}`, { qaId: String(fx.outsider) });
      expect((await pm.get(`/api/tasks/${task.id}`)).body.data.qa.id).toBe(String(fx.outsider));
      expect(await Notification.findOne({ recipient: fx.outsider, title: /You are now the QA/, body: /1 task is waiting/ })).toBeTruthy();
      const qa = await login(app, "outsider@t.test");
      expect((await qa.get("/api/tasks?qaId=me&status=IN_QA")).body.data.map((t: { id: string }) => t.id)).toEqual([task.id]);
    });

    it("projects without a QA keep the old flow: approval finishes the task", async () => {
      const task = await readyForReview(false);
      expect((await pm.post(`/api/tasks/${task.id}/approve`)).body.data.status).toBe("APPROVED");
    });

    it("a QA can be assigned mid-project; moving the project to QA testing hands them the approved work", async () => {
      // Approved before the project had a QA, so it skipped testing.
      const task = await readyForReview(false);
      await pm.post(`/api/tasks/${task.id}/approve`);

      expect((await pm.patch(`/api/projects/${fx.project}`, { qaId: String(fx.outsider) })).body.data.qa.id).toBe(String(fx.outsider));
      expect(await Notification.findOne({ recipient: fx.outsider, title: /You are now the QA/ })).toBeTruthy();

      const testing = await pm.patch(`/api/projects/${fx.project}`, { status: "QA_TESTING" });
      expect(testing.body.data.status).toBe("QA_TESTING");
      expect((await pm.get(`/api/tasks/${task.id}`)).body.data).toMatchObject({ status: "IN_QA", qa: { id: String(fx.outsider) } });
      expect(await Notification.findOne({ recipient: fx.outsider, title: /ready for QA testing/ })).toBeTruthy();

      // Once passed, re-entering QA testing doesn't send it again.
      const qa = await login(app, "outsider@t.test");
      await qa.post(`/api/tasks/${task.id}/qa/pass`);
      await pm.patch(`/api/projects/${fx.project}`, { status: "ACTIVE" });
      await pm.patch(`/api/projects/${fx.project}`, { status: "QA_TESTING" });
      expect((await pm.get(`/api/tasks/${task.id}`)).body.data.status).toBe("APPROVED");
    });

    it("a project can enter QA testing before it has a QA; the work goes to the QA when one is added", async () => {
      const task = await readyForReview(false);
      await pm.post(`/api/tasks/${task.id}/approve`);

      const testing = await pm.patch(`/api/projects/${fx.project}`, { status: "QA_TESTING" });
      expect(testing.status).toBe(200);
      expect((await pm.get(`/api/tasks/${task.id}`)).body.data).toMatchObject({ status: "IN_QA", qa: null });

      await pm.patch(`/api/projects/${fx.project}`, { qaId: String(fx.outsider) });
      expect((await pm.get(`/api/tasks/${task.id}`)).body.data.qa.id).toBe(String(fx.outsider));
      expect(await Notification.findOne({ recipient: fx.outsider, title: /You are now the QA/, body: /1 task is waiting/ })).toBeTruthy();
    });

    it("the project manager sets a QA deadline per task; the QA is told and reminded", async () => {
      const task = await readyForReview();
      await pm.post(`/api/tasks/${task.id}/approve`);
      const second = await createTask({ title: "Second in QA" });
      await pm.patch(`/api/tasks/${second.id}/status`, { status: "IN_QA" });

      // Only managers set it; the developer can't.
      expect((await emp.patch(`/api/tasks/${task.id}`, { qaDueDate: "2030-02-01" })).status).toBe(403);

      const set = await pm.patch(`/api/tasks/${task.id}`, { qaDueDate: "2030-02-10" });
      expect(set.status).toBe(200);
      expect(set.body.data.qaDueDate).toBe("2030-02-10");
      expect(await Notification.findOne({ recipient: fx.outsider, type: "DEADLINE_APPROACHING", title: /Finish QA on Checkout API by 2030-02-10/ })).toBeTruthy();
      await pm.patch(`/api/tasks/${second.id}`, { qaDueDate: "2030-02-05" });

      // The QA queue can be ordered by QA deadline.
      const qa = await login(app, "outsider@t.test");
      const queue = await qa.get("/api/tasks?qaId=me&status=IN_QA&sortBy=qaDueDate&sortOrder=asc");
      expect(queue.body.data.map((t: { title: string; qaDueDate: string }) => [t.title, t.qaDueDate])).toEqual([
        ["Second in QA", "2030-02-05"],
        ["Checkout API", "2030-02-10"],
      ]);

      // Reminder the day before, sent once.
      const dayBefore = new Date("2030-02-09T12:00:00Z");
      expect(await runQaDeadlineReminders(dayBefore)).toBe(1);
      expect(await runQaDeadlineReminders(dayBefore)).toBe(0);
      expect(await Notification.findOne({ recipient: fx.outsider, title: /QA on Checkout API is due on 2030-02-10/ })).toBeTruthy();

      // Clearing it stops reminders.
      expect((await pm.patch(`/api/tasks/${task.id}`, { qaDueDate: null })).body.data.qaDueDate).toBeNull();
      expect((await Task.findById(task.id).lean())?.lastQaReminderAt).toBeNull();
    });

    it("a new QA takes over tasks waiting in QA", async () => {
      const task = await readyForReview();
      await pm.post(`/api/tasks/${task.id}/approve`);
      await pm.patch(`/api/projects/${fx.project}`, { qaId: String(fx.pm) });
      expect((await pm.get(`/api/tasks/${task.id}`)).body.data.qa.id).toBe(String(fx.pm));
    });

    it("the PM picks the QA tester and QA due date; until then it's on the PM's list", async () => {
      const task = await readyForReview();
      await pm.post(`/api/tasks/${task.id}/approve`);
      const setup = async () => ((await pm.get("/api/tasks/my-day")).body.data.qaSetup as { id: string }[]).map((t) => t.id);
      expect(await setup()).toEqual([task.id]); // no QA due date yet

      // The developer can't be their own tester.
      const own = await pm.patch(`/api/tasks/${task.id}`, { qaId: String(fx.emp) });
      expect(own.status).toBe(422);
      expect(own.body.errors[0].path).toBe("qaId");
      // Only managers choose the tester.
      expect((await emp.patch(`/api/tasks/${task.id}`, { qaId: String(fx.emp2) })).status).toBe(403);

      const res = await pm.patch(`/api/tasks/${task.id}`, { qaId: String(fx.emp2), qaDueDate: "2026-12-01" });
      expect(res.body.data).toMatchObject({ status: "IN_QA", qa: { id: String(fx.emp2) }, qaDueDate: "2026-12-01", assignee: { id: String(fx.emp) } });
      expect(await Notification.findOne({ recipient: fx.emp2, title: /asked you to QA test/, body: /2026-12-01/ })).toBeTruthy();
      expect(await setup()).toEqual([]);

      // The new tester has it in their queue and can pass it.
      const emp2 = await login(app, "emp2@t.test");
      expect((await emp2.get("/api/tasks/my-day")).body.data.qaQueue.map((t: { id: string }) => t.id)).toEqual([task.id]);
      expect((await emp2.post(`/api/tasks/${task.id}/qa/pass`)).body.data.status).toBe("APPROVED");
    });

    it("QA reports typed issues with steps, expected/actual, environment and screenshots", async () => {
      const task = await readyForReview();
      await pm.post(`/api/tasks/${task.id}/approve`);
      const qa = await login(app, "outsider@t.test");
      const res = await qa.post(`/api/tasks/${task.id}/qa/fail`, {
        bugs: [
          {
            kind: "DEFECT",
            title: "Coupon not applied",
            priority: "URGENT",
            steps: "1. Add item\n2. Apply SAVE10",
            expected: "Total drops 10%",
            actual: "Total unchanged",
            environment: "Chrome 129 · Windows 11",
          },
          { kind: "UI", title: "Button overlaps footer" },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.data.bugIds).toHaveLength(2);
      expect(res.body.data.subtasks.map((s: { issueKind: string; priority: string }) => [s.issueKind, s.priority])).toEqual([
        ["DEFECT", "URGENT"],
        ["UI", "HIGH"],
      ]);

      const issue = (await emp.get(`/api/tasks/${res.body.data.bugIds[0]}`)).body.data;
      expect(issue).toMatchObject({
        type: "BUG",
        tags: ["bug", "defect"],
        assignee: { id: String(fx.emp) },
        qaIssue: { kind: "DEFECT", steps: "1. Add item\n2. Apply SAVE10", expected: "Total drops 10%", actual: "Total unchanged", environment: "Chrome 129 · Windows 11", reportedBy: { id: String(fx.outsider) } },
      });
      // The QA can open (and attach screenshots to) the issues they reported.
      expect((await qa.get(`/api/tasks/${res.body.data.bugIds[1]}`)).status).toBe(200);
      expect((await qa.post(`/api/tasks/${task.id}/qa/fail`, { bugs: [{ kind: "NONSENSE", title: "abc" }] })).status).toBe(422);
    });

    it("QA logs issues as they test (task stays in QA), then QA complete sends them back together", async () => {
      const task = await readyForReview();
      await pm.post(`/api/tasks/${task.id}/approve`);
      const qa = await login(app, "outsider@t.test");

      // Two separate reports while testing: the task stays with QA and the developer isn't pinged yet.
      const first = await qa.post(`/api/tasks/${task.id}/qa/issues`, { bugs: [{ kind: "BUG", title: "Login button does nothing" }] });
      expect(first.status).toBe(200);
      expect(first.body.data.status).toBe("IN_QA");
      expect(first.body.data.bugIds).toHaveLength(1);
      await qa.post(`/api/tasks/${task.id}/qa/issues`, { bugs: [{ kind: "UI", title: "Footer overlaps" }, { kind: "DEFECT", title: "Wrong total", priority: "URGENT" }] });
      const during = (await qa.get(`/api/tasks/${task.id}`)).body.data;
      expect(during.status).toBe("IN_QA");
      expect(during.subtasks).toHaveLength(3);
      expect(await Notification.findOne({ recipient: fx.emp, type: "CHANGES_REQUESTED" })).toBeNull();
      // The developer can't complete QA.
      expect((await emp.post(`/api/tasks/${task.id}/qa/complete`)).status).toBe(403);

      // QA complete: everything logged this round goes back at once.
      const done = await qa.post(`/api/tasks/${task.id}/qa/complete`, { note: "Three problems." });
      expect(done.body.data).toMatchObject({ status: "CHANGES_REQUESTED", openIssues: 3 });
      const sentBack = await Notification.findOne({ recipient: fx.emp, type: "CHANGES_REQUESTED" }).lean();
      expect(sentBack?.title).toMatch(/QA found 3 issues/);
      expect(sentBack?.body).toMatch(/\[UI\/UX\] Footer overlaps/);
      expect((await qa.post(`/api/tasks/${task.id}/qa/issues`, { bugs: [{ title: "Too late" }] })).status).toBe(422); // no longer in QA

      // Next round: earlier issues left open don't count again; with nothing new, QA complete passes.
      await emp.post(`/api/tasks/${task.id}/submit`);
      await pm.post(`/api/tasks/${task.id}/approve`);
      expect((await qa.get(`/api/tasks/${task.id}`)).body.data.status).toBe("IN_QA");
      const passed = await qa.post(`/api/tasks/${task.id}/qa/complete`);
      expect(passed.body.data).toMatchObject({ status: "APPROVED", openIssues: 0 });
    });

    it("on the workflow's QA stage, logged issues go to Bug fixing when QA completes", async () => {
      await pm.post(`/api/projects/${fx.project}/workflow`, { frontendId: String(fx.emp), qaId: String(fx.head) });
      const flow = async () => (await pm.get(`/api/projects/${fx.project}/workflow`)).body.data as { id: string; stage: string; status: string; subtaskCount: number }[];
      const frontend = (await flow()).find((s) => s.stage === "FRONTEND")!;
      await emp.post(`/api/tasks/${frontend.id}/submit`);
      await pm.post(`/api/tasks/${frontend.id}/approve`);
      const qaStage = (await flow()).find((s) => s.stage === "QA")!;
      expect(qaStage.status).toBe("IN_QA");
      const qa = await login(app, "head@t.test");

      await qa.post(`/api/tasks/${qaStage.id}/qa/issues`, { bugs: [{ title: "Checkout broken" }] });
      await qa.post(`/api/tasks/${qaStage.id}/qa/issues`, { bugs: [{ title: "Search slow", kind: "PERFORMANCE" }] });
      expect((await flow()).find((s) => s.stage === "QA")!.status).toBe("IN_QA");
      expect((await flow()).find((s) => s.stage === "BUG_FIXING")!.status).toBe("WAITING");

      expect((await qa.post(`/api/tasks/${qaStage.id}/qa/complete`)).body.data).toMatchObject({ status: "WAITING", openIssues: 2 });
      expect((await flow()).find((s) => s.stage === "BUG_FIXING")).toMatchObject({ status: "TODO", subtaskCount: 2 });
    });

    it("new projects must name a QA", async () => {
      const res = await pm.post("/api/projects", { name: "No QA project", type: "INTERNAL" });
      expect(res.status).toBe(422);
      expect(res.body.errors.map((e: { path: string }) => e.path)).toContain("qaId");
    });
  });

  describe("staged workflow", () => {
    type Stage = { id: string; stage: string; status: string; assignee: { id: string } | null; qa: { id: string } | null; subtaskCount: number };
    const stages = async () => (await pm.get(`/api/projects/${fx.project}/workflow`)).body.data as Stage[];
    const byStage = async (name: string) => (await stages()).find((s) => s.stage === name)!;

    it("runs Design → PM → Frontend + Backend → PM → QA → bugs → Bug fixing → PM → QA retest → done", async () => {
      const designer = await login(app, "outsider@t.test");
      const emp2 = await login(app, "emp2@t.test");
      const qa = await login(app, "head@t.test");

      const setup = await pm.post(`/api/projects/${fx.project}/workflow`, {
        designerId: String(fx.outsider),
        frontendId: String(fx.emp),
        backendId: String(fx.emp2),
        qaId: String(fx.head),
      });
      expect(setup.status).toBe(201);
      expect(setup.body.data.map((s: Stage) => [s.stage, s.status])).toEqual([
        ["DESIGN", "TODO"],
        ["FRONTEND", "WAITING"],
        ["BACKEND", "WAITING"],
        ["QA", "WAITING"],
        ["BUG_FIXING", "WAITING"],
      ]);
      expect(setup.body.data.find((s: Stage) => s.stage === "BUG_FIXING").assignee.id).toBe(String(fx.emp)); // defaults to the frontend dev
      expect((await pm.get(`/api/projects/${fx.project}`)).body.data).toMatchObject({ workflow: true, qa: { id: String(fx.head) } });
      expect((await pm.post(`/api/projects/${fx.project}/workflow`, { frontendId: String(fx.emp) })).status).toBe(409);

      // Later stages are locked until the stage before them is approved.
      const frontend = await byStage("FRONTEND");
      expect((await emp.patch(`/api/tasks/${frontend.id}/status`, { status: "IN_PROGRESS" })).status).toBe(422);
      expect((await emp.post(`/api/tasks/${frontend.id}/submit`)).status).toBe(422);

      // Designer → PM review → development opens.
      const design = await byStage("DESIGN");
      expect((await designer.post(`/api/tasks/${design.id}/submit`)).body.data.status).toBe("IN_REVIEW");
      expect(await Notification.findOne({ recipient: fx.pm, type: "REVIEW_REQUESTED" })).toBeTruthy();
      await pm.post(`/api/tasks/${design.id}/approve`);
      expect((await byStage("FRONTEND")).status).toBe("TODO");
      expect((await byStage("BACKEND")).status).toBe("TODO");
      expect(await Notification.findOne({ recipient: fx.emp2, title: /Backend development .* is ready for you to start/ })).toBeTruthy();

      // Both developers → PM review; QA opens only when both are approved.
      await emp.post(`/api/tasks/${frontend.id}/submit`);
      expect((await pm.post(`/api/tasks/${frontend.id}/approve`)).body.data.status).toBe("APPROVED"); // no per-task QA hop
      expect((await byStage("QA")).status).toBe("WAITING");
      const backend = await byStage("BACKEND");
      await emp2.post(`/api/tasks/${backend.id}/submit`);
      await pm.post(`/api/tasks/${backend.id}/approve`);
      const qaStage = await byStage("QA");
      expect(qaStage).toMatchObject({ status: "IN_QA", qa: { id: String(fx.head) } });
      expect((await pm.get(`/api/projects/${fx.project}`)).body.data.status).toBe("QA_TESTING");

      // QA reports bugs → they go to the developer in Bug fixing; QA waits.
      const failed = await qa.post(`/api/tasks/${qaStage.id}/qa/fail`, { bugs: [{ title: "Login button does nothing" }, { title: "Totals off by one" }] });
      expect(failed.status).toBe(200);
      expect(failed.body.data.status).toBe("WAITING");
      const bugFixing = await byStage("BUG_FIXING");
      expect(bugFixing).toMatchObject({ status: "TODO", subtaskCount: 2 });
      const bugs = await Task.find({ parent: bugFixing.id }).lean();
      expect(bugs.every((b) => String(b.assignee) === String(fx.emp))).toBe(true);
      expect(await Notification.findOne({ recipient: fx.pm, title: /QA found 2 issues/ })).toBeTruthy();

      // All bugs must be fixed before Bug fixing goes to the PM.
      expect((await emp.post(`/api/tasks/${bugFixing.id}/submit`)).status).toBe(422);
      for (const b of bugs) {
        await emp.patch(`/api/tasks/${b._id}/status`, { status: "IN_PROGRESS" });
        await emp.patch(`/api/tasks/${b._id}/status`, { status: "COMPLETED" });
      }
      expect((await emp.post(`/api/tasks/${bugFixing.id}/submit`)).body.data.status).toBe("IN_REVIEW");
      await pm.post(`/api/tasks/${bugFixing.id}/approve`);
      expect((await byStage("QA")).status).toBe("IN_QA"); // back to QA for a retest

      expect((await qa.post(`/api/tasks/${qaStage.id}/qa/pass`)).body.data.status).toBe("APPROVED");
      expect(await Notification.findOne({ recipient: fx.pm, title: /passed QA/ })).toBeTruthy();
      expect((await stages()).every((s) => s.status === "APPROVED")).toBe(true);
    });

    it("can be set up while creating a project; stages without a person are skipped", async () => {
      const res = await pm.post("/api/projects", {
        name: "Gamma App",
        type: "INTERNAL",
        qaId: String(fx.head),
        workflow: { frontendId: String(fx.emp), bugFixerId: String(fx.emp2) },
      });
      expect(res.status).toBe(201);
      const flow = (await pm.get(`/api/projects/${res.body.data.id}/workflow`)).body.data as Stage[];
      expect(flow.map((s) => [s.stage, s.status, s.assignee?.id])).toEqual([
        ["FRONTEND", "TODO", String(fx.emp)],
        ["QA", "WAITING", String(fx.head)],
        ["BUG_FIXING", "WAITING", String(fx.emp2)],
      ]);
      const bad = await pm.post("/api/projects", { name: "Delta", type: "INTERNAL", qaId: String(fx.head), workflow: {} });
      expect(bad.status).toBe(422);
      expect(bad.body.errors.map((e: { path: string }) => e.path)).toContain("workflow");
    });

    it("stage subtasks: the developer's list, roll-up, PM-only completion, per-subtask QA, retest, approval and shipping", async () => {
      const qa = await login(app, "head@t.test");
      await pm.post(`/api/projects/${fx.project}/workflow`, { frontendId: String(fx.emp), backendId: String(fx.emp2), qaId: String(fx.head) });
      const frontend = await byStage("FRONTEND");
      expect(frontend.status).toBe("TODO");

      // Subtasks of a stage go to that stage's developer and show in their task list.
      const sub = async (title: string) => (await pm.post("/api/tasks", { title, projectId: String(fx.project), parentId: frontend.id })).body.data as { id: string; assignee: { id: string } };
      const login_ = await sub("Login page");
      const signup = await sub("Signup page");
      expect(login_.assignee.id).toBe(String(fx.emp));
      const mine = await emp.get("/api/tasks?assigneeId=me");
      expect(mine.body.data.map((t: { title: string }) => t.title)).toEqual(expect.arrayContaining(["Login page", "Signup page"]));

      // Developers work and send for review, but can't complete; the stage follows its subtasks.
      await emp.patch(`/api/tasks/${login_.id}/status`, { status: "IN_PROGRESS" });
      expect((await byStage("FRONTEND")).status).toBe("IN_PROGRESS");
      expect((await emp.patch(`/api/tasks/${login_.id}/status`, { status: "COMPLETED" })).status).toBe(403);
      expect((await emp.post(`/api/tasks/${frontend.id}/submit`)).status).toBe(422); // the stage moves on its own
      await emp.post(`/api/tasks/${login_.id}/submit`);
      expect((await byStage("FRONTEND")).status).toBe("IN_PROGRESS");
      await emp.post(`/api/tasks/${signup.id}/submit`);
      expect((await byStage("FRONTEND")).status).toBe("IN_REVIEW");

      // Testing needs every subtask completed; the PM completes them by approving.
      expect((await pm.patch(`/api/tasks/${frontend.id}/status`, { status: "IN_QA" })).status).toBe(422);
      expect((await pm.post(`/api/tasks/${login_.id}/approve`)).body.data.status).toBe("COMPLETED");
      await pm.post(`/api/tasks/${signup.id}/approve`);
      expect((await byStage("FRONTEND")).status).toBe("COMPLETED");
      // (The PM approved them, so the roll-up is recorded in activity rather than notifying the PM about their own action.)
      expect(await Activity.findOne({ entityId: frontend.id, verb: /every subtask is completed/ })).toBeTruthy();
      expect((await pm.post(`/api/tasks/${frontend.id}/approve`)).status).toBe(422); // test it first

      // The PM sets the stage to Testing: QA receives each subtask (not the stage itself).
      expect((await pm.patch(`/api/tasks/${frontend.id}/status`, { status: "IN_QA" })).body.data.status).toBe("IN_QA");
      const queue = await qa.get("/api/tasks?qaId=me&status=IN_QA");
      expect(queue.body.data.map((t: { title: string }) => t.title).sort()).toEqual(["Login page", "Signup page"]);
      expect(await Notification.findOne({ recipient: fx.head, title: /2 subtasks of Frontend development.* are ready for testing/ })).toBeTruthy();
      expect((await qa.post(`/api/tasks/${frontend.id}/qa/pass`)).status).toBe(422); // QA tests the subtasks, not the stage
      expect((await pm.patch(`/api/tasks/${login_.id}/status`, { status: "TESTED" })).status).toBe(422); // set by QA only

      // QA passes one and reports a defect on the other: the stage is Tested, the defect goes to the developer.
      expect((await qa.post(`/api/tasks/${login_.id}/qa/pass`)).body.data.status).toBe("TESTED");
      expect((await byStage("FRONTEND")).status).toBe("IN_QA");
      const failed = await qa.post(`/api/tasks/${signup.id}/qa/fail`, { bugs: [{ kind: "DEFECT", title: "Password rules not shown" }] });
      expect(failed.body.data).toMatchObject({ status: "CHANGES_REQUESTED", qaResult: "BUGS" });
      expect((await byStage("FRONTEND")).status).toBe("TESTED");
      expect(await Notification.findOne({ recipient: fx.pm, title: /QA finished testing Frontend development/, body: /1 subtask has findings/ })).toBeTruthy();
      expect((await pm.post(`/api/tasks/${frontend.id}/approve`)).status).toBe(422); // findings still open

      // The developer ticks off the defect, fixes and resubmits; the PM's approval sends it back to QA.
      const [defect] = await Task.find({ parent: signup.id }).lean();
      expect(String(defect!.assignee)).toBe(String(fx.emp));
      await emp.patch(`/api/tasks/${defect!._id}/status`, { status: "IN_PROGRESS" });
      expect((await emp.patch(`/api/tasks/${defect!._id}/status`, { status: "COMPLETED" })).status).toBe(200);
      await emp.patch(`/api/tasks/${signup.id}/status`, { status: "IN_PROGRESS" });
      await emp.post(`/api/tasks/${signup.id}/submit`);
      expect((await pm.post(`/api/tasks/${signup.id}/approve`)).body.data.status).toBe("IN_QA");
      expect((await byStage("FRONTEND")).status).toBe("IN_QA");
      expect(await Notification.findOne({ recipient: fx.head, title: /Signup page is fixed and ready to retest/ })).toBeTruthy();

      // Retest passes: the stage is Tested and the PM approves it, which opens the next stage.
      await qa.post(`/api/tasks/${signup.id}/qa/pass`);
      expect((await byStage("FRONTEND")).status).toBe("TESTED");
      expect((await pm.post(`/api/tasks/${frontend.id}/approve`)).body.data.status).toBe("APPROVED");

      // Shipping: only once every task is done.
      const ship = await pm.patch(`/api/projects/${fx.project}`, { status: "COMPLETED" });
      expect(ship.status).toBe(422);
      expect(ship.body.message).toMatch(/still open/);
      await Task.updateMany({ project: fx.project, status: { $nin: ["COMPLETED", "TESTED", "APPROVED"] } }, { status: "APPROVED" });
      expect((await pm.patch(`/api/projects/${fx.project}`, { status: "COMPLETED" })).body.data.status).toBe("COMPLETED");
    });

    it("choosing In QA on a reviewed stage subtask approves it and sends it to QA; the stage follows", async () => {
      const qa = await login(app, "head@t.test");
      await pm.post(`/api/projects/${fx.project}/workflow`, { frontendId: String(fx.emp), qaId: String(fx.head) });
      const frontend = await byStage("FRONTEND");
      const sub = async (title: string) => (await pm.post("/api/tasks", { title, projectId: String(fx.project), parentId: frontend.id })).body.data as { id: string };
      const a = await sub("Login");
      const b = await sub("Signup");
      await emp.post(`/api/tasks/${a.id}/submit`);
      await emp.post(`/api/tasks/${b.id}/submit`);

      // In QA from review → approved and with the QA right away (not just Completed).
      const sent = await pm.patch(`/api/tasks/${a.id}/status`, { status: "IN_QA" });
      expect(sent.status).toBe(200);
      expect(sent.body.data).toMatchObject({ status: "IN_QA", qa: { id: String(fx.head) } });
      expect(await Notification.findOne({ recipient: fx.head, title: /Login is ready for QA testing/ })).toBeTruthy();
      expect((await qa.get("/api/tasks/my-day")).body.data.qaQueue.map((t: { id: string }) => t.id)).toEqual([a.id]);
      // A completed subtask can be sent too.
      await pm.post(`/api/tasks/${b.id}/approve`);
      expect((await pm.patch(`/api/tasks/${b.id}/status`, { status: "IN_QA" })).body.data.status).toBe("IN_QA");
      expect((await byStage("FRONTEND")).status).toBe("IN_QA");

      // QA tests both → the stage is Tested and the PM approves it.
      await qa.post(`/api/tasks/${a.id}/qa/pass`);
      expect((await byStage("FRONTEND")).status).toBe("IN_QA");
      await qa.post(`/api/tasks/${b.id}/qa/pass`);
      expect((await byStage("FRONTEND")).status).toBe("TESTED");
      expect((await pm.post(`/api/tasks/${frontend.id}/approve`)).body.data.status).toBe("APPROVED");
    });

    it("a new project QA also takes over the QA stage", async () => {
      await pm.post(`/api/projects/${fx.project}/workflow`, { frontendId: String(fx.emp), qaId: String(fx.head) });
      await pm.patch(`/api/projects/${fx.project}`, { qaId: String(fx.outsider) });
      expect((await byStage("QA")).assignee!.id).toBe(String(fx.outsider));
    });
  });

  it("tasks waiting for my QA show in my task list", async () => {
    await Project.updateOne({ _id: fx.project }, { qa: fx.outsider });
    const task = await createTask();
    const qa = await login(app, "outsider@t.test");
    const ids = async (query: string) => ((await qa.get(`/api/tasks?${query}`)).body.data as { id: string }[]).map((t) => t.id);
    expect(await ids("assigneeId=me&includeQa=true")).toEqual([]);
    await emp.post(`/api/tasks/${task.id}/submit`);
    await pm.post(`/api/tasks/${task.id}/approve`); // → In QA with the project's QA
    expect(await ids("assigneeId=me&includeQa=true")).toEqual([task.id]);
    expect(await ids("assigneeId=me")).toEqual([]); // without the flag: only assigned work
    // Once QA has decided, it leaves their list.
    await qa.post(`/api/tasks/${task.id}/qa/pass`);
    expect(await ids("assigneeId=me&includeQa=true")).toEqual([]);
  });

  it("work sent for review shows in the reviewer's (or PM's) task list", async () => {
    // A subtask without its own reviewer is reviewed by the project manager.
    const parent = await createTask();
    const sub = (await pm.post("/api/tasks", { title: "Login form", projectId: String(fx.project), parentId: parent.id, assigneeId: String(fx.emp) })).body.data;
    const ids = async (s: typeof pm, query: string) => ((await s.get(`/api/tasks?${query}`)).body.data as { id: string }[]).map((t) => t.id);

    expect(await ids(pm, "awaitingReview=true")).toEqual([]);
    await emp.post(`/api/tasks/${sub.id}/submit`);
    await emp.post(`/api/tasks/${parent.id}/submit`); // has its own reviewer: the PM
    expect((await ids(pm, "awaitingReview=true")).sort()).toEqual([parent.id, sub.id].sort());
    expect((await ids(pm, "assigneeId=me&includeReviews=true")).sort()).toEqual([parent.id, sub.id].sort());
    // Without the flag, "mine" is still only what's assigned to me.
    expect(await ids(pm, "assigneeId=me")).toEqual([]);
    // The developer's own list doesn't treat their submitted work as theirs to review.
    expect(await ids(emp, "awaitingReview=true")).toEqual([]);
    // Another PM doesn't see it.
    const pm2 = await login(app, "pm2@t.test");
    expect(await ids(pm2, "awaitingReview=true")).toEqual([]);

    // Once reviewed, it leaves the queue.
    await pm.post(`/api/tasks/${sub.id}/approve`);
    expect(await ids(pm, "awaitingReview=true")).toEqual([parent.id]);
  });

  it("a stage that is in review because of its subtasks isn't in the review queue (its subtasks are)", async () => {
    await pm.post(`/api/projects/${fx.project}/workflow`, { frontendId: String(fx.emp), qaId: String(fx.head) });
    const frontend = ((await pm.get(`/api/projects/${fx.project}/workflow`)).body.data as { id: string; stage: string }[]).find((s) => s.stage === "FRONTEND")!;
    const sub = (await pm.post("/api/tasks", { title: "Login", projectId: String(fx.project), parentId: frontend.id })).body.data;
    await emp.post(`/api/tasks/${sub.id}/submit`);
    expect((await pm.get(`/api/tasks/${frontend.id}`)).body.data.status).toBe("IN_REVIEW");
    expect(((await pm.get("/api/tasks?awaitingReview=true")).body.data as { id: string }[]).map((t) => t.id)).toEqual([sub.id]);
  });

  it("deletes a project with everything in it (admin only)", async () => {
    const task = await createTask();
    await pm.post("/api/tasks", { title: "Subtask", projectId: String(fx.project), parentId: task.id });
    await emp.post(`/api/tasks/${task.id}/comments`, { body: "On it" });
    await pm.post("/api/milestones", { projectId: String(fx.project), name: "Beta", dueDate: "2026-12-01" });

    expect((await pm.del(`/api/projects/${fx.project}`)).status).toBe(403);
    const admin = await login(app, "admin@t.test");
    expect((await admin.del(`/api/projects/${fx.project}`)).status).toBe(204);

    expect(await Project.exists({ _id: fx.project })).toBeNull();
    expect(await Task.countDocuments({ project: fx.project })).toBe(0);
    expect((await admin.get(`/api/projects/${fx.project}`)).status).toBe(404);
    expect(await Notification.countDocuments({ entityId: task.id })).toBe(0);
    expect(await Activity.findOne({ entityType: "PROJECT", entityId: fx.project, type: "PROJECT_DELETED" })).toBeTruthy();
    // Other projects are untouched.
    expect(await Project.exists({ _id: fx.otherProject })).toBeTruthy();
  });

  it("deletes a task with its subtasks and comments (manager only)", async () => {
    const task = await createTask();
    await pm.post("/api/tasks", { title: "Child task", projectId: String(fx.project), parentId: task.id });
    expect((await emp.del(`/api/tasks/${task.id}`)).status).toBe(403);
    expect((await pm.del(`/api/tasks/${task.id}`)).status).toBe(204);
    expect((await pm.get(`/api/tasks/${task.id}`)).status).toBe(404);
    expect((await pm.get("/api/tasks")).body.meta.total).toBe(0);
  });
});
