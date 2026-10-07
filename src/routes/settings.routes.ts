import { Router } from "express";
import { z } from "zod";
import { currentUser } from "../middleware/auth.middleware";
import { requirePermission } from "../middleware/permission.middleware";
import { parseBody } from "../middleware/validation.middleware";
import { Setting, User } from "../models";
import { NOTIFICATION_TYPES } from "../types/domain";
import { ok } from "../utils/http";

const DEFAULT_COMPANY = { name: "Your company", timezone: "UTC", workingHoursPerDay: 8, weekStartsOn: 1 as const };

const companySchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    timezone: z.string().trim().min(1).max(64).refine((tz) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "Use an IANA timezone, e.g. Asia/Colombo."),
    workingHoursPerDay: z.number().min(1).max(24),
    weekStartsOn: z.union([z.literal(0), z.literal(1)]),
  })
  .partial();

const prefMap = z.partialRecord(z.enum(NOTIFICATION_TYPES), z.boolean());
const preferencesSchema = z.object({ email: prefMap.default({}), inApp: prefMap.default({}) });

const serializeCompany = (s: { name: string; timezone: string; workingHoursPerDay: number; weekStartsOn: 0 | 1 } | null) => ({
  name: s?.name ?? DEFAULT_COMPANY.name,
  timezone: s?.timezone ?? DEFAULT_COMPANY.timezone,
  workingHoursPerDay: s?.workingHoursPerDay ?? DEFAULT_COMPANY.workingHoursPerDay,
  weekStartsOn: s?.weekStartsOn ?? DEFAULT_COMPANY.weekStartsOn,
});

export const settingsRouter = Router();

settingsRouter.get("/company", async (_req, res) => {
  ok(res, serializeCompany(await Setting.findOne({ key: "company" }).lean()));
});

settingsRouter.patch("/company", requirePermission("settings:company"), async (req, res) => {
  const input = parseBody(companySchema, req);
  const updated = await Setting.findOneAndUpdate(
    { key: "company" },
    { $set: input, $setOnInsert: { key: "company", ...Object.fromEntries(Object.entries(DEFAULT_COMPANY).filter(([k]) => !(k in input))) } },
    { upsert: true, returnDocument: "after", runValidators: true },
  ).lean();
  ok(res, serializeCompany(updated), "Company settings saved.");
});

settingsRouter.get("/notifications", async (req, res) => {
  const user = await User.findById(currentUser(req)._id).select("notificationPreferences").lean();
  ok(res, { email: user?.notificationPreferences?.email ?? {}, inApp: user?.notificationPreferences?.inApp ?? {} });
});

settingsRouter.put("/notifications", async (req, res) => {
  const prefs = parseBody(preferencesSchema, req);
  await User.updateOne({ _id: currentUser(req)._id }, { notificationPreferences: prefs });
  ok(res, prefs, "Notification preferences saved.");
});
