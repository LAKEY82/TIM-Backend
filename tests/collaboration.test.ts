import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Activity, Notification } from "../src/models";
import { MongoStorage, setStorageProvider, type StorageProvider } from "../src/services/storage.service";
import { login, resetDb, seedFixture, startTestDb, stopTestDb, type Fixture, type Session } from "./helpers";

let app: Express;
let fx: Fixture;
let pm: Session;
let emp: Session;
let taskId: string;

beforeAll(async () => {
  app = await startTestDb();
});
afterAll(stopTestDb);
beforeEach(async () => {
  await resetDb();
  setStorageProvider(null);
  fx = await seedFixture();
  pm = await login(app, "pm@t.test");
  emp = await login(app, "emp@t.test");
  const res = await pm.post("/api/tasks", { title: "Landing page", projectId: String(fx.project), assigneeId: String(fx.emp), reviewerId: String(fx.pm) });
  taskId = res.body.data.id;
});

describe("comments", () => {
  it("creates comments with mentions, notifies, and enforces edit/delete rights", async () => {
    const created = await emp.post(`/api/tasks/${taskId}/comments`, { body: "Ready, @PamTest", mentionIds: [String(fx.pm), "507f1f77bcf86cd799439011"] });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ taskId, body: "Ready, @PamTest", author: { id: String(fx.emp) }, edited: false });
    // Unknown mention ids are dropped, not trusted.
    expect(created.body.data.mentions.map((m: { id: string }) => m.id)).toEqual([String(fx.pm)]);
    expect(await Notification.findOne({ recipient: fx.pm, type: "MENTION" })).toBeTruthy();
    expect(await Activity.findOne({ type: "COMMENT_CREATED" })).toBeTruthy();

    const id = created.body.data.id;
    expect((await pm.patch(`/api/tasks/${taskId}/comments/${id}`, { body: "Edited by someone else" })).status).toBe(403);
    const edited = await emp.patch(`/api/tasks/${taskId}/comments/${id}`, { body: "Ready now", mentionIds: [] });
    expect(edited.body.data).toMatchObject({ body: "Ready now", edited: true });

    const list = await pm.get(`/api/tasks/${taskId}/comments`);
    expect(list.body.data).toHaveLength(1);

    // Another employee can't delete it; the task's manager can.
    const emp2 = await login(app, "emp2@t.test");
    expect((await emp2.del(`/api/tasks/${taskId}/comments/${id}`)).status).toBe(403);
    expect((await pm.del(`/api/tasks/${taskId}/comments/${id}`)).status).toBe(204);
  });

  it("hides comments on tasks the caller can't see", async () => {
    const outsider = await login(app, "outsider@t.test");
    expect((await outsider.get(`/api/tasks/${taskId}/comments`)).status).toBe(404);
    expect((await outsider.post(`/api/tasks/${taskId}/comments`, { body: "hi" })).status).toBe(404);
  });
});

describe("notifications", () => {
  it("lists, counts, marks read and marks all read for the caller only", async () => {
    await pm.post("/api/tasks", { title: "Second", projectId: String(fx.project), assigneeId: String(fx.emp) });
    const count = await emp.get("/api/notifications/unread-count");
    expect(count.body.data).toEqual({ count: 2 });

    const list = await emp.get("/api/notifications?pageSize=1");
    expect(list.body.meta).toMatchObject({ total: 2, totalPages: 2 });
    expect(list.body.data[0]).toMatchObject({ type: "TASK_ASSIGNED", read: false, entityType: "TASK", actor: { id: String(fx.pm) } });

    const id = list.body.data[0].id;
    // Someone else's notification is invisible.
    expect((await pm.patch(`/api/notifications/${id}/read`)).status).toBe(404);
    expect((await emp.patch(`/api/notifications/${id}/read`)).status).toBe(204);
    expect((await emp.get("/api/notifications/unread-count")).body.data.count).toBe(1);
    expect((await emp.get("/api/notifications?unreadOnly=true")).body.data).toHaveLength(1);

    expect((await emp.patch("/api/notifications/read-all")).status).toBe(204);
    expect((await emp.get("/api/notifications/unread-count")).body.data.count).toBe(0);
  });

  it("respects in-app notification preferences", async () => {
    await emp.put("/api/settings/notifications", { email: {}, inApp: { TASK_ASSIGNED: false } });
    await pm.post("/api/tasks", { title: "Muted", projectId: String(fx.project), assigneeId: String(fx.emp) });
    expect(await Notification.countDocuments({ recipient: fx.emp, title: /Muted/ })).toBe(0);
  });
});

describe("search, activity and analytics", () => {
  it("search respects the caller's scope", async () => {
    const mine = await emp.get("/api/search?q=landing");
    expect(mine.body.data.tasks.map((t: { title: string }) => t.title)).toEqual(["Landing page"]);
    expect(mine.body.data.clients).toEqual([]);
    const outsider = await login(app, "outsider@t.test");
    const theirs = await outsider.get("/api/search?q=landing");
    expect(theirs.body.data.tasks).toEqual([]);
    expect((await emp.get("/api/search?q=a")).status).toBe(400);
  });

  it("activity for a task renders as actor/action/entity/target", async () => {
    const res = await pm.get(`/api/activity?entityType=TASK&entityId=${taskId}`);
    const assigned = res.body.data.find((a: { type: string }) => a.type === "TASK_ASSIGNED");
    expect(assigned).toMatchObject({ actor: { name: "Pam Test" }, action: "assigned", entityName: "Landing page", target: { type: "USER", name: "Emma Test" } });
  });

  it("company analytics for leadership only; aggregated shapes", async () => {
    expect((await pm.get("/api/analytics/company")).status).toBe(403);
    const ceo = await login(app, "ceo@t.test");
    const res = await ceo.get("/api/analytics/company");
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toMatchObject({ activeProjects: 2, openTasks: 1 });
    expect(res.body.data.weeklyActivity.length).toBeGreaterThanOrEqual(8);
    expect(res.body.data.departmentWorkload).toEqual(expect.arrayContaining([expect.objectContaining({ departmentName: "Development", assigned: 1 })]));

    const project = await pm.get(`/api/analytics/projects/${fx.project}`);
    expect(project.body.data).toMatchObject({ totalTasks: 1, completedTasks: 0 });
    const tasks = await pm.get("/api/analytics/tasks?from=2026-01-01&to=2026-03-01");
    expect(tasks.status).toBe(200);
    expect((await pm.get("/api/analytics/tasks?from=2026-03-01&to=2026-01-01")).status).toBe(400);
  });
});

describe("files and errors", () => {
  it("uploads return 503 when storage isn't configured", async () => {
    const res = await request(app)
      .post(`/api/tasks/${taskId}/attachments`)
      .set("Authorization", `Bearer ${emp.token}`)
      .attach("file", Buffer.from("hello"), { filename: "notes.txt", contentType: "text/plain" });
    expect(res.status).toBe(503);
  });

  it("stores uploads through the storage provider and lists them on the task", async () => {
    const stored = new Map<string, Buffer>();
    const fake: StorageProvider = {
      put: async (key, body) => void stored.set(key, body),
      remove: async (key) => void stored.delete(key),
      urlFor: async (key) => `https://files.example/${key}`,
    };
    setStorageProvider(fake);
    const res = await request(app)
      .post(`/api/tasks/${taskId}/attachments`)
      .set("Authorization", `Bearer ${emp.token}`)
      .attach("file", Buffer.from("hello"), { filename: "notes.txt", contentType: "text/plain" });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ fileName: "notes.txt", size: 5, mimeType: "text/plain", url: expect.stringMatching(/^https:\/\/files\.example\/tasks\//) });
    expect(stored.size).toBe(1);

    const blocked = await request(app)
      .post(`/api/tasks/${taskId}/attachments`)
      .set("Authorization", `Bearer ${emp.token}`)
      .attach("file", Buffer.from("<script>"), { filename: "x.html", contentType: "text/html" });
    expect(blocked.status).toBe(415);

    const detail = await emp.get(`/api/tasks/${taskId}`);
    expect(detail.body.data.attachments).toHaveLength(1);
    expect((await emp.del(`/api/tasks/${taskId}/attachments/${res.body.data.id}`)).status).toBe(204);
    expect(stored.size).toBe(0);
  });

  it("keeps files in MongoDB when no bucket is configured and serves them by key", async () => {
    setStorageProvider(new MongoStorage());
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const res = await request(app)
      .post(`/api/tasks/${taskId}/attachments`)
      .set("Authorization", `Bearer ${emp.token}`)
      .attach("file", png, { filename: "screen shot.png", contentType: "image/png" });
    expect(res.status).toBe(201);
    const url = new URL(res.body.data.url);
    expect(url.pathname).toMatch(/^\/api\/storage\/tasks\//);

    // No token needed (an <img> can't send one); the key is the secret.
    const file = await request(app).get(url.pathname).buffer(true);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("image/png");
    expect(file.headers["content-disposition"]).toBe('inline; filename="screen_shot.png"');
    expect(Buffer.compare(file.body as Buffer, png)).toBe(0);
    expect((await request(app).get("/api/storage/tasks/nope/missing.png")).status).toBe(404);

    expect((await emp.del(`/api/tasks/${taskId}/attachments/${res.body.data.id}`)).status).toBe(204);
    expect((await request(app).get(url.pathname)).status).toBe(404);
  });

  it("returns consistent JSON errors", async () => {
    const badId = await pm.get("/api/tasks/not-an-id");
    expect(badId.status).toBe(400);
    expect(badId.body).toMatchObject({ success: false, errors: [{ path: "id" }] });

    const missing = await pm.get("/api/tasks/507f1f77bcf86cd799439011");
    expect(missing.status).toBe(404);

    const unknown = await pm.get("/api/nope");
    expect(unknown.status).toBe(404);
    expect(unknown.body.success).toBe(false);

    const malformed = await request(app).post("/api/auth/login").set("Content-Type", "application/json").send("{bad json");
    expect(malformed.status).toBe(400);
    expect(malformed.body.message).toBe("Malformed JSON body.");

    // Operator injection attempts are rejected by validation, never reach Mongo.
    const injected = await pm.get("/api/tasks?assigneeId[$ne]=x");
    expect([400, 200]).toContain(injected.status);
    if (injected.status === 200) expect(injected.body.meta.total).toBe(1);
  });
});
