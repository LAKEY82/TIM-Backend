import type { Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Task } from "../src/models";
import { login, resetDb, seedFixture, startTestDb, stopTestDb, type Fixture } from "./helpers";

let app: Express;
let fx: Fixture;

beforeAll(async () => {
  app = await startTestDb();
});
afterAll(stopTestDb);
beforeEach(async () => {
  await resetDb();
  fx = await seedFixture();
});

describe("permission checks (server-side, independent of the UI)", () => {
  it("employees cannot create projects, clients, users or departments", async () => {
    const emp = await login(app, "emp@t.test");
    expect((await emp.post("/api/projects", { name: "Nope", type: "INTERNAL" })).status).toBe(403);
    expect((await emp.post("/api/clients", { name: "Nope Inc" })).status).toBe(403);
    expect((await emp.post("/api/users", { name: "New Person", email: "n@t.test", role: "ADMIN" })).status).toBe(403);
    expect((await emp.post("/api/departments", { name: "Shadow IT" })).status).toBe(403);
    expect((await emp.get("/api/clients")).status).toBe(403);
    expect((await emp.get("/api/analytics/company")).status).toBe(403);
  });

  it("users can edit their own profile but not their role, status or other people", async () => {
    const emp = await login(app, "emp@t.test");
    const self = await emp.patch(`/api/users/${fx.emp}`, { name: "Emma Renamed", jobTitle: "Engineer" });
    expect(self.status).toBe(200);
    expect(self.body.data).toMatchObject({ name: "Emma Renamed", firstName: "Emma", lastName: "Renamed", jobTitle: "Engineer" });

    expect((await emp.patch(`/api/users/${fx.emp}`, { role: "ADMIN" })).status).toBe(403);
    expect((await emp.patch(`/api/users/${fx.emp2}`, { jobTitle: "Hacked" })).status).toBe(403);
  });

  it("admins manage users; deactivation signs the user out immediately", async () => {
    const admin = await login(app, "admin@t.test");
    const emp2 = await login(app, "emp2@t.test");
    const created = await admin.post("/api/users", { name: "New Hire", email: "new@t.test", role: "EMPLOYEE", departmentId: String(fx.deptDev), password: "Welcome123" });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ name: "New Hire", email: "new@t.test", departmentId: String(fx.deptDev) });

    const dup = await admin.post("/api/users", { name: "Dup", email: "NEW@t.test", role: "EMPLOYEE" });
    expect(dup.status).toBe(409);
    expect(dup.body.errors[0].path).toBe("email");

    expect((await admin.patch(`/api/users/${fx.emp2}`, { status: "INACTIVE" })).status).toBe(200);
    expect((await emp2.get("/api/auth/me")).status).toBe(401);
    // Admins can't lock themselves out.
    expect((await admin.patch(`/api/users/${fx.admin}`, { role: "EMPLOYEE" })).status).toBe(403);
  });

  it("role changes apply on the next request (role is read from the database)", async () => {
    const emp = await login(app, "emp@t.test");
    expect((await emp.post("/api/clients", { name: "Acme" })).status).toBe(403);
    const admin = await login(app, "admin@t.test");
    await admin.patch(`/api/users/${fx.emp}`, { role: "CEO" });
    expect((await emp.post("/api/clients", { name: "Acme" })).status).toBe(201);
  });
});

describe("project scoping", () => {
  it("non-members don't see a project (404, not 403, to avoid leaking existence)", async () => {
    const outsider = await login(app, "outsider@t.test");
    expect((await outsider.get(`/api/projects/${fx.project}`)).status).toBe(404);
    const list = await outsider.get("/api/projects");
    expect(list.body.data).toHaveLength(0);

    const ceo = await login(app, "ceo@t.test");
    expect((await ceo.get("/api/projects")).body.data).toHaveLength(2);
  });

  it("an assigned task grants visibility of its project", async () => {
    await Task.create({ title: "Cross-team help", project: fx.otherProject, assignee: fx.outsider });
    const outsider = await login(app, "outsider@t.test");
    expect((await outsider.get(`/api/projects/${fx.otherProject}`)).status).toBe(200);
  });

  it("a project manager can only change projects they manage", async () => {
    const pm = await login(app, "pm@t.test");
    expect((await pm.patch(`/api/projects/${fx.project}`, { status: "AT_RISK" })).status).toBe(200);
    expect((await pm.patch(`/api/projects/${fx.otherProject}`, { status: "AT_RISK" })).status).toBe(404);

    const pm2 = await login(app, "pm2@t.test");
    await pm2.post(`/api/projects/${fx.otherProject}/members`, { userId: String(fx.pm) });
    // Now pm can see it, but still can't manage it.
    expect((await pm.get(`/api/projects/${fx.otherProject}`)).status).toBe(200);
    expect((await pm.patch(`/api/projects/${fx.otherProject}`, { status: "AT_RISK" })).status).toBe(403);
  });

  it("members can't create tasks without tasks:create; managers can", async () => {
    const emp = await login(app, "emp@t.test");
    expect((await emp.post("/api/tasks", { title: "My own task", projectId: String(fx.project) })).status).toBe(403);
    const pm2 = await login(app, "pm2@t.test");
    // pm2 has tasks:create but isn't on Alpha Portal.
    expect((await pm2.post("/api/tasks", { title: "Sneaky task", projectId: String(fx.project) })).status).toBe(404);
  });
});
