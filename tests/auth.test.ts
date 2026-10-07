import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Session, User } from "../src/models";
import type * as MailService from "../src/services/mail.service";
import { login, ORIGIN, PASSWORD, resetDb, seedFixture, startTestDb, stopTestDb, type Fixture } from "./helpers";

// Capture outgoing email so the reset link can be followed.
const sent = vi.hoisted(() => [] as { to: string; text: string }[]);
vi.mock("../src/services/mail.service", async (importOriginal) => {
  const original = await importOriginal<typeof MailService>();
  return {
    ...original,
    sendMail: async (mail: { to: string; text: string }) => {
      sent.push(mail);
      return true;
    },
  };
});

let app: Express;
let fx: Fixture;

beforeAll(async () => {
  app = await startTestDb();
});
afterAll(stopTestDb);
beforeEach(async () => {
  await resetDb();
  fx = await seedFixture();
  sent.length = 0;
});

const cookieOf = (res: request.Response) => ([] as string[]).concat(res.headers["set-cookie"] ?? []).find((c) => c.startsWith("tim_rt="));

describe("login", () => {
  it("returns the user with permissions and an access token, and sets an httpOnly refresh cookie", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "PM@t.test", password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data.user).toMatchObject({ email: "pm@t.test", role: "PROJECT_MANAGER", name: "Pam Test", status: "ACTIVE" });
    expect(res.body.data.user.permissions).toEqual(expect.arrayContaining(["projects:create", "tasks:review"]));
    expect(res.body.data.user.passwordHash).toBeUndefined();
    const cookie = cookieOf(res)!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/auth/);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it("rejects a wrong password and unknown emails with the same message", async () => {
    const wrong = await request(app).post("/api/auth/login").send({ email: "pm@t.test", password: "nope-1234" });
    const unknown = await request(app).post("/api/auth/login").send({ email: "ghost@t.test", password: "nope-1234" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.message).toBe(unknown.body.message);
  });

  it("rejects inactive and suspended accounts", async () => {
    await User.updateOne({ _id: fx.emp }, { status: "SUSPENDED" });
    const res = await request(app).post("/api/auth/login").send({ email: "emp@t.test", password: PASSWORD });
    expect(res.status).toBe(401);
  });

  it("validates the body (422 with field errors)", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "not-an-email", password: "" });
    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.errors.map((e: { path: string }) => e.path)).toEqual(expect.arrayContaining(["email", "password"]));
  });
});

describe("me / protected routes", () => {
  it("requires a bearer token", async () => {
    expect((await request(app).get("/api/auth/me")).status).toBe(401);
    expect((await request(app).get("/api/projects")).status).toBe(401);
    expect((await request(app).get("/api/projects").set("Authorization", "Bearer garbage")).status).toBe(401);
  });

  it("returns the current user", async () => {
    const s = await login(app, "emp@t.test");
    const res = await s.get("/api/auth/me");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ email: "emp@t.test", role: "EMPLOYEE", departmentId: String(fx.deptDev), department: { name: "Development" } });
    expect(res.body.data.permissions).toEqual(["timeline:read"]);
  });

  it("rejects tokens of users deactivated after login", async () => {
    const s = await login(app, "emp@t.test");
    await User.updateOne({ _id: fx.emp }, { status: "INACTIVE" });
    expect((await s.get("/api/auth/me")).status).toBe(401);
  });
});

describe("refresh token rotation", () => {
  it("issues a new access token and rotates the cookie", async () => {
    const s = await login(app, "emp@t.test");
    const res = await request(app).post("/api/auth/refresh").set("Origin", ORIGIN).set("Cookie", s.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    const rotated = cookieOf(res)!.split(";")[0]!;
    expect(rotated).not.toBe(s.cookie);

    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${res.body.data.accessToken}`);
    expect(me.status).toBe(200);
  });

  it("revokes the session when an old refresh token is replayed", async () => {
    const s = await login(app, "emp@t.test");
    const first = await request(app).post("/api/auth/refresh").set("Cookie", s.cookie);
    const rotated = cookieOf(first)!.split(";")[0]!;

    const replay = await request(app).post("/api/auth/refresh").set("Cookie", s.cookie);
    expect(replay.status).toBe(401);
    // The legitimate (rotated) token is now dead too, and so is the access token.
    expect((await request(app).post("/api/auth/refresh").set("Cookie", rotated)).status).toBe(401);
    expect((await s.get("/api/auth/me")).status).toBe(401);
  });

  it("rejects requests without a cookie or from foreign origins", async () => {
    expect((await request(app).post("/api/auth/refresh")).status).toBe(401);
    const s = await login(app, "emp@t.test");
    const res = await request(app).post("/api/auth/refresh").set("Origin", "https://evil.example").set("Cookie", s.cookie);
    expect(res.status).toBe(403);
  });
});

describe("logout", () => {
  it("revokes the session: refresh and the access token stop working", async () => {
    const s = await login(app, "emp@t.test");
    const res = await request(app).post("/api/auth/logout").set("Origin", ORIGIN).set("Cookie", s.cookie);
    expect(res.status).toBe(204);
    expect(cookieOf(res)).toMatch(/tim_rt=;/);
    expect((await request(app).post("/api/auth/refresh").set("Cookie", s.cookie)).status).toBe(401);
    expect((await s.get("/api/auth/me")).status).toBe(401);
    expect(await Session.countDocuments({ revokedAt: null })).toBe(0);
  });
});

describe("password reset", () => {
  it("always answers 200 and emails a working single-use link", async () => {
    const unknown = await request(app).post("/api/auth/forgot-password").send({ email: "ghost@t.test" });
    expect(unknown.status).toBe(200);
    expect(sent).toHaveLength(0);

    const s = await login(app, "emp@t.test");
    const res = await request(app).post("/api/auth/forgot-password").send({ email: "emp@t.test" });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    const token = new URL(/https?:\/\/\S+/.exec(sent[0]!.text)![0]).searchParams.get("token")!;

    expect((await request(app).post("/api/auth/reset-password").send({ token, password: "short" })).status).toBe(422);
    const reset = await request(app).post("/api/auth/reset-password").send({ token, password: "NewPassw0rd" });
    expect(reset.status).toBe(200);

    // Old sessions are revoked, the old password no longer works, the link is single-use.
    expect((await s.get("/api/auth/me")).status).toBe(401);
    expect((await request(app).post("/api/auth/login").send({ email: "emp@t.test", password: PASSWORD })).status).toBe(401);
    expect((await request(app).post("/api/auth/login").send({ email: "emp@t.test", password: "NewPassw0rd" })).status).toBe(200);
    expect((await request(app).post("/api/auth/reset-password").send({ token, password: "Another1pass" })).status).toBe(422);
  });

  it("changes the password with the current one and signs out other devices", async () => {
    const phone = await login(app, "emp@t.test");
    const laptop = await login(app, "emp@t.test");
    const bad = await laptop.post("/api/auth/change-password", { currentPassword: "wrong", newPassword: "NewPassw0rd" });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0].path).toBe("currentPassword");

    const ok = await laptop.post("/api/auth/change-password", { currentPassword: PASSWORD, newPassword: "NewPassw0rd" });
    expect(ok.status).toBe(200);
    // Other device: session revoked.
    expect((await request(app).post("/api/auth/refresh").set("Cookie", phone.cookie)).status).toBe(401);
    // This device: refresh into a fresh access token.
    expect((await request(app).post("/api/auth/refresh").set("Cookie", laptop.cookie)).status).toBe(200);
  });
});
