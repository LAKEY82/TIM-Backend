import type { Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

describe("project links", () => {
  it("tags Figma and GitHub links from their URL and names them sensibly", async () => {
    const base = `/api/projects/${fx.project}/links`;
    const figma = await emp.post(base, { url: "https://www.figma.com/design/AbC123/Checkout-flow?node-id=1-2" });
    expect(figma.status).toBe(201);
    expect(figma.body.data).toMatchObject({ kind: "FIGMA", title: "Checkout flow", addedBy: { id: String(fx.emp) } });
    const repo = await emp.post(base, { url: "https://github.com/theiavora/tim-backend/pulls" });
    expect(repo.body.data).toMatchObject({ kind: "GITHUB", title: "theiavora/tim-backend" });
    const docs = await emp.post(base, { title: "API docs", url: "https://docs.example.com/api" });
    expect(docs.body.data).toMatchObject({ kind: "OTHER", title: "API docs" });

    expect((await pm.get(base)).body.data.map((l: { kind: string }) => l.kind)).toEqual(["FIGMA", "GITHUB", "OTHER"]);
    expect((await emp.post(base, { url: "figma file" })).status).toBe(422);
    expect((await emp.post(base, { url: "javascript:alert(1)" })).status).toBe(422);
  });

  it("only project members see links; the adder or the PM changes them", async () => {
    const base = `/api/projects/${fx.project}/links`;
    const id = (await emp.post(base, { url: "https://github.com/a/b" })).body.data.id as string;

    const outsider = await login(app, "outsider@t.test");
    expect((await outsider.get(base)).status).toBe(404);
    const emp2 = await login(app, "emp2@t.test");
    expect((await emp2.patch(`${base}/${id}`, { title: "Mine" })).status).toBe(403);

    // Changing the URL re-tags it.
    const moved = await emp.patch(`${base}/${id}`, { url: "https://www.figma.com/file/XyZ/Old-designs" });
    expect(moved.body.data).toMatchObject({ kind: "FIGMA", title: "a/b" });
    expect((await pm.del(`${base}/${id}`)).status).toBe(204);
    expect((await pm.get(base)).body.data).toEqual([]);
  });
});
