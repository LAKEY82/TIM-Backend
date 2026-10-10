import { Router } from "express";
import { type QueryFilter, Types } from "mongoose";
import { z } from "zod";
import { currentUser } from "../middleware/auth.middleware";
import { parseBody, parseQuery, routeParam, validateObjectIds } from "../middleware/validation.middleware";
import { Meeting, User, type IMeeting } from "../models";
import { accessibleProject } from "../services/access.service";
import { notify } from "../services/notification.service";
import type { AuthUser } from "../types/express";
import { MEETING_PLATFORMS } from "../types/domain";
import { forbidden, notFound, unprocessable } from "../utils/errors";
import { created, noContent, ok, paginated } from "../utils/http";
import { serializeMeeting } from "../utils/serialize";
import { objectId, optionalText, paginationQuery, searchRegex } from "../validators/common";

const USER_SUMMARY = "firstName lastName email profileImage role jobTitle";
const POPULATE = [
  { path: "organizer", select: USER_SUMMARY },
  { path: "participants", select: USER_SUMMARY },
  { path: "project", select: "name" },
];

const listQuery = z
  .object({
    /** Upcoming (not ended yet, soonest first) or past (most recent first). */
    scope: z.enum(["upcoming", "past", "all"]).default("upcoming"),
    search: z.string().max(100).optional(),
    /** Meetings that overlap this window (e.g. one day for My Day). ISO timestamps. */
    from: z.iso.datetime({ offset: true }).transform((v) => new Date(v)).optional(),
    to: z.iso.datetime({ offset: true }).transform((v) => new Date(v)).optional(),
  })
  .and(paginationQuery(100));

const meetingFields = {
  title: z.string().trim().min(2, "Title must be at least 2 characters.").max(200),
  description: optionalText(5000),
  platform: z.enum(MEETING_PLATFORMS),
  link: z
    .union([z.url("Enter the full meeting link, e.g. https://zoom.us/j/123"), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v === "" ? null : v)),
  startAt: z.iso.datetime({ offset: true, message: "Choose a start date and time." }).transform((v) => new Date(v)),
  endAt: z.iso.datetime({ offset: true, message: "Choose an end time." }).transform((v) => new Date(v)),
  projectId: objectId.nullable().optional(),
};

const endsAfterStart = (v: { startAt?: Date; endAt?: Date }, ctx: z.RefinementCtx) => {
  if (v.startAt && v.endAt && v.endAt <= v.startAt) ctx.addIssue({ code: "custom", path: ["endAt"], message: "The meeting must end after it starts." });
};

const createSchema = z.object({ ...meetingFields, participantIds: z.array(objectId).max(200).default([]) }).superRefine(endsAfterStart);
const updateSchema = z.object(meetingFields).partial().superRefine(endsAfterStart);
const participantsSchema = z.object({ userIds: z.array(objectId).min(1, "Choose at least one person.").max(200) });

/** Meetings someone can see: ones they organise or are invited to (admins see all). */
const visibleTo = (user: AuthUser): QueryFilter<IMeeting> =>
  user.permissions.has("users:manage") ? {} : { $or: [{ organizer: user._id }, { participants: user._id }] };

const canManage = (user: AuthUser, m: Pick<IMeeting, "organizer">) => String(m.organizer) === String(user._id) || user.permissions.has("users:manage");

async function loadVisible(user: AuthUser, id: string) {
  const meeting = await Meeting.findOne({ _id: id, ...visibleTo(user) });
  if (!meeting) throw notFound("Meeting");
  return meeting;
}

/** Only active people can be invited; unknown ids are an error rather than silently dropped. */
async function activeUsers(ids: string[]) {
  const unique = [...new Set(ids)];
  const found = await User.find({ _id: { $in: unique }, status: "ACTIVE" }).distinct("_id");
  if (found.length !== unique.length) throw unprocessable("Some participants couldn't be found.", [{ path: "participantIds", message: "Choose active people." }]);
  return found as Types.ObjectId[];
}

const when = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ") + " UTC";

function invite(actor: AuthUser, recipients: Types.ObjectId[], meeting: { _id: Types.ObjectId; title: string; startAt: Date }) {
  void notify({
    recipients,
    actor: actor._id,
    type: "MEETING_INVITE",
    title: `${actor.name} invited you to ${meeting.title}`,
    body: `Starts ${when(meeting.startAt)}.`,
    entityType: "MEETING",
    entityId: meeting._id,
  });
}

async function detail(id: Types.ObjectId) {
  const meeting = await Meeting.findById(id).populate(POPULATE).lean();
  if (!meeting) throw notFound("Meeting");
  return serializeMeeting(meeting);
}

export const meetingsRouter = Router();
meetingsRouter.param("id", (req, res, next) => validateObjectIds("id")(req, res, next));

meetingsRouter.get("/", async (req, res) => {
  const user = currentUser(req);
  const q = parseQuery(listQuery, req);
  const now = new Date();
  const filter: QueryFilter<IMeeting> = { ...visibleTo(user) };
  if (q.scope === "upcoming") filter.endAt = { $gte: now };
  if (q.scope === "past") filter.endAt = { $lt: now };
  const re = searchRegex(q.search);
  if (re) filter.title = re;
  if (q.from) filter.endAt = { ...(filter.endAt as object), $gt: q.from };
  if (q.to) filter.startAt = { $lt: q.to };
  const sort = q.scope === "past" ? { startAt: -1 as const } : { startAt: 1 as const };
  const [items, total] = await Promise.all([
    Meeting.find(filter).populate(POPULATE).sort({ ...sort, _id: 1 }).skip(q.skip).limit(q.pageSize).lean(),
    Meeting.countDocuments(filter),
  ]);
  paginated(res, items.map(serializeMeeting), { page: q.page, pageSize: q.pageSize, total });
});

meetingsRouter.post("/", async (req, res) => {
  const user = currentUser(req);
  const { participantIds, projectId, ...input } = parseBody(createSchema, req);
  if (projectId) await accessibleProject(user, projectId);
  const participants = (await activeUsers(participantIds)).filter((id) => String(id) !== String(user._id));
  const meeting = await Meeting.create({ ...input, project: projectId ?? null, organizer: user._id, participants });
  invite(user, participants, meeting);
  created(res, await detail(meeting._id), "Meeting created.");
});

meetingsRouter.get("/:id", async (req, res) => {
  const meeting = await loadVisible(currentUser(req), routeParam(req, "id"));
  ok(res, await detail(meeting._id));
});

meetingsRouter.patch("/:id", async (req, res) => {
  const user = currentUser(req);
  const meeting = await loadVisible(user, routeParam(req, "id"));
  if (!canManage(user, meeting)) throw forbidden("Only the organizer can edit this meeting.");
  const { projectId, ...input } = parseBody(updateSchema, req);
  const start = input.startAt ?? meeting.startAt;
  const end = input.endAt ?? meeting.endAt;
  if (end <= start) throw unprocessable("The meeting must end after it starts.", [{ path: "endAt", message: "The meeting must end after it starts." }]);
  if (projectId) await accessibleProject(user, projectId);
  const rescheduled = start.getTime() !== meeting.startAt.getTime();
  meeting.set(Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)));
  if (projectId !== undefined) meeting.project = projectId ? new Types.ObjectId(projectId) : null;
  await meeting.save();
  if (rescheduled) {
    void notify({
      recipients: meeting.participants,
      actor: user._id,
      type: "MEETING_INVITE",
      title: `${meeting.title} was moved`,
      body: `It now starts ${when(meeting.startAt)}.`,
      entityType: "MEETING",
      entityId: meeting._id,
    });
  }
  ok(res, await detail(meeting._id), "Meeting updated.");
});

meetingsRouter.delete("/:id", async (req, res) => {
  const user = currentUser(req);
  const meeting = await loadVisible(user, routeParam(req, "id"));
  if (!canManage(user, meeting)) throw forbidden("Only the organizer can delete this meeting.");
  await meeting.deleteOne();
  noContent(res);
});

// Participants can be added and removed at any time after the meeting is created.
meetingsRouter.post("/:id/participants", async (req, res) => {
  const user = currentUser(req);
  const meeting = await loadVisible(user, routeParam(req, "id"));
  if (!canManage(user, meeting)) throw forbidden("Only the organizer can invite people.");
  const { userIds } = parseBody(participantsSchema, req);
  const existing = new Set([String(meeting.organizer), ...meeting.participants.map(String)]);
  const added = (await activeUsers(userIds)).filter((id) => !existing.has(String(id)));
  if (added.length) {
    meeting.participants.push(...added);
    await meeting.save();
    invite(user, added, meeting);
  }
  ok(res, await detail(meeting._id), added.length ? `${added.length} participant${added.length === 1 ? "" : "s"} added.` : "Already invited.");
});

meetingsRouter.delete("/:id/participants/:userId", async (req, res) => {
  const user = currentUser(req);
  const meeting = await loadVisible(user, routeParam(req, "id"));
  const target = routeParam(req, "userId");
  // The organizer removes anyone; a participant can leave on their own.
  if (!canManage(user, meeting) && target !== String(user._id)) throw forbidden("Only the organizer can remove people.");
  meeting.participants = meeting.participants.filter((p) => String(p) !== target);
  await meeting.save();
  ok(res, await detail(meeting._id), "Participant removed.");
});
