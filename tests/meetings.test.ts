import type { Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Notification } from "../src/models";
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

const inDays = (days: number, hours = 0) => new Date(Date.now() + days * 86_400_000 + hours * 3_600_000).toISOString();

const standup = () => ({
  title: "Sprint planning",
  platform: "ZOOM",
  link: "https://zoom.us/j/123456789",
  startAt: inDays(1),
  endAt: inDays(1, 1),
  participantIds: [String(fx.emp)],
});

describe("meetings", () => {
  it("creates a meeting with participants, a link and a platform, and invites them", async () => {
    const res = await pm.post("/api/meetings", standup());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      title: "Sprint planning",
      platform: "ZOOM",
      link: "https://zoom.us/j/123456789",
      organizer: { id: String(fx.pm) },
      participants: [{ id: String(fx.emp) }],
    });
    expect(await Notification.findOne({ recipient: fx.emp, type: "MEETING_INVITE", entityType: "MEETING" })).toBeTruthy();

    // Participants see it; people who aren't invited don't.
    expect((await emp.get("/api/meetings")).body.data.map((m: { title: string }) => m.title)).toEqual(["Sprint planning"]);
    const outsider = await login(app, "outsider@t.test");
    expect((await outsider.get("/api/meetings")).body.data).toEqual([]);
    expect((await outsider.get(`/api/meetings/${res.body.data.id}`)).status).toBe(404);
  });

  it("validates the time and the link", async () => {
    const bad = await pm.post("/api/meetings", { ...standup(), endAt: inDays(0), link: "zoom meeting" });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.map((e: { path: string }) => e.path).sort()).toEqual(["endAt", "link"]);
  });

  it("adds and removes participants after the meeting is created; only the organizer manages it", async () => {
    const id = (await pm.post("/api/meetings", { ...standup(), participantIds: [] })).body.data.id as string;

    const added = await pm.post(`/api/meetings/${id}/participants`, { userIds: [String(fx.emp), String(fx.emp2)] });
    expect(added.body.data.participants.map((p: { id: string }) => p.id).sort()).toEqual([String(fx.emp), String(fx.emp2)].sort());
    expect(await Notification.countDocuments({ type: "MEETING_INVITE" })).toBe(2);
    // Inviting someone twice doesn't duplicate them or the invite.
    await pm.post(`/api/meetings/${id}/participants`, { userIds: [String(fx.emp)] });
    expect(await Notification.countDocuments({ type: "MEETING_INVITE" })).toBe(2);

    // A participant can't manage the meeting, but can leave it.
    expect((await emp.patch(`/api/meetings/${id}`, { title: "Mine now" })).status).toBe(403);
    expect((await emp.post(`/api/meetings/${id}/participants`, { userIds: [String(fx.outsider)] })).status).toBe(403);
    const left = await emp.del(`/api/meetings/${id}/participants/${fx.emp}`);
    expect(left.body.data.participants.map((p: { id: string }) => p.id)).toEqual([String(fx.emp2)]);

    // The organizer edits, reschedules (participants are told) and deletes.
    const moved = await pm.patch(`/api/meetings/${id}`, { platform: "GOOGLE_MEET", link: "https://meet.google.com/abc-defg-hij", startAt: inDays(2), endAt: inDays(2, 1) });
    expect(moved.body.data).toMatchObject({ platform: "GOOGLE_MEET", link: "https://meet.google.com/abc-defg-hij" });
    expect(await Notification.findOne({ recipient: fx.emp2, title: /was moved/ })).toBeTruthy();
    expect((await pm.del(`/api/meetings/${id}`)).status).toBe(204);
  });

  it("lists the meetings that overlap a time window (one day for My Day)", async () => {
    await pm.post("/api/meetings", standup()); // tomorrow
    await pm.post("/api/meetings", { ...standup(), title: "Next week", startAt: inDays(7), endAt: inDays(7, 1) });
    const from = inDays(0, 12);
    const to = inDays(2);
    const res = await pm.get(`/api/meetings?scope=all&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(res.body.data.map((m: { title: string }) => m.title)).toEqual(["Sprint planning"]);
  });

  it("splits upcoming and past meetings", async () => {
    await pm.post("/api/meetings", standup());
    await pm.post("/api/meetings", { ...standup(), title: "Retro", startAt: inDays(-2), endAt: inDays(-2, 1) });
    expect((await pm.get("/api/meetings")).body.data.map((m: { title: string }) => m.title)).toEqual(["Sprint planning"]);
    expect((await pm.get("/api/meetings?scope=past")).body.data.map((m: { title: string }) => m.title)).toEqual(["Retro"]);
  });
});
