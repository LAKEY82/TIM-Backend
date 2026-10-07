/**
 * Test harness: a real Express app against a real (in-memory) MongoDB.
 * Fixtures here exist only for tests.
 */
import type { Express } from "express";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { type Types } from "mongoose";
import request from "supertest";
import { createApp } from "../src/app";
import { connectDatabase } from "../src/config/database";
import { Department, Project, User } from "../src/models";
import { hashPassword } from "../src/services/auth.service";
import type { Role } from "../src/types/domain";

export const PASSWORD = "Password123!";
export const ORIGIN = "http://localhost:3000";

let mongod: MongoMemoryServer | null = null;

export async function startTestDb(): Promise<Express> {
  mongod = await MongoMemoryServer.create();
  await connectDatabase(mongod.getUri("tim-test"));
  await mongoose.connection.syncIndexes();
  return createApp();
}

export async function stopTestDb() {
  await mongoose.disconnect();
  await mongod?.stop();
}

export async function resetDb() {
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

export interface Fixture {
  deptDev: Types.ObjectId;
  deptDesign: Types.ObjectId;
  admin: Types.ObjectId;
  ceo: Types.ObjectId;
  pm: Types.ObjectId;
  pm2: Types.ObjectId;
  head: Types.ObjectId;
  emp: Types.ObjectId;
  emp2: Types.ObjectId;
  outsider: Types.ObjectId;
  project: Types.ObjectId;
  otherProject: Types.ObjectId;
}

/** Users for every role, two departments and two projects. */
export async function seedFixture(): Promise<Fixture> {
  const passwordHash = await hashPassword(PASSWORD);
  const [deptDev, deptDesign] = await Department.insertMany([{ name: "Development" }, { name: "Design" }]);
  const mk = (firstName: string, email: string, role: Role, department = deptDev!._id) =>
    ({ firstName, lastName: "Test", email, role, department, passwordHash });
  const users = await User.insertMany([
    mk("Admin", "admin@t.test", "ADMIN"),
    mk("Ceo", "ceo@t.test", "CEO"),
    mk("Pam", "pm@t.test", "PROJECT_MANAGER"),
    mk("Pete", "pm2@t.test", "PROJECT_MANAGER"),
    mk("Hedy", "head@t.test", "DEPARTMENT_HEAD", deptDesign!._id),
    mk("Emma", "emp@t.test", "EMPLOYEE"),
    mk("Eric", "emp2@t.test", "EMPLOYEE"),
    mk("Otto", "outsider@t.test", "EMPLOYEE", deptDesign!._id),
  ]);
  const id = (email: string) => users.find((u) => u.email === email)!._id;
  const [project, otherProject] = await Project.insertMany([
    { name: "Alpha Portal", type: "INTERNAL", status: "ACTIVE", manager: id("pm@t.test"), members: [id("emp@t.test"), id("emp2@t.test")], department: deptDev!._id },
    { name: "Beta Store", type: "INTERNAL", status: "ACTIVE", manager: id("pm2@t.test"), members: [], department: deptDev!._id },
  ]);
  return {
    deptDev: deptDev!._id,
    deptDesign: deptDesign!._id,
    admin: id("admin@t.test"),
    ceo: id("ceo@t.test"),
    pm: id("pm@t.test"),
    pm2: id("pm2@t.test"),
    head: id("head@t.test"),
    emp: id("emp@t.test"),
    emp2: id("emp2@t.test"),
    outsider: id("outsider@t.test"),
    project: project!._id,
    otherProject: otherProject!._id,
  };
}

export interface Session {
  token: string;
  cookie: string;
  get: (path: string) => request.Test;
  post: (path: string, body?: object) => request.Test;
  patch: (path: string, body?: object) => request.Test;
  put: (path: string, body?: object) => request.Test;
  del: (path: string) => request.Test;
}

/** Logs in and returns helpers that send the bearer token. */
export async function login(app: Express, email: string, password = PASSWORD): Promise<Session> {
  const res = await request(app).post("/api/auth/login").set("Origin", ORIGIN).send({ email, password });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  const token = res.body.data.accessToken as string;
  const cookie = ([] as string[]).concat(res.headers["set-cookie"] ?? []).find((c) => c.startsWith("tim_rt="))!.split(";")[0]!;
  const auth = (t: request.Test) => t.set("Authorization", `Bearer ${token}`).set("Origin", ORIGIN);
  return {
    token,
    cookie,
    get: (p) => auth(request(app).get(p)),
    post: (p, b = {}) => auth(request(app).post(p)).send(b),
    patch: (p, b = {}) => auth(request(app).patch(p)).send(b),
    put: (p, b = {}) => auth(request(app).put(p)).send(b),
    del: (p) => auth(request(app).delete(p)),
  };
}
