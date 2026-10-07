import { Router } from "express";
import { Types, type QueryFilter } from "mongoose";
import { z } from "zod";
import { requirePermission } from "../middleware/permission.middleware";
import { parseBody, parseQuery, validateObjectIds } from "../middleware/validation.middleware";
import { Department, Team, User, type ITeam } from "../models";
import { notFound, unprocessable } from "../utils/errors";
import { created, noContent, ok, paginated } from "../utils/http";
import { serializeTeam } from "../utils/serialize";
import { objectId, optionalText, paginationQuery, searchRegex } from "../validators/common";

const teamInput = z.object({
  name: z.string().trim().min(2).max(80),
  description: optionalText(1000),
  departmentId: objectId,
  leadId: objectId.nullable().optional(),
  memberIds: z.array(objectId).max(200).default([]),
});

const listQuery = z.object({ departmentId: objectId.optional(), search: z.string().max(100).optional() }).and(paginationQuery());

const POPULATE = [
  { path: "department", select: "name" },
  { path: "lead", select: "firstName lastName email profileImage role jobTitle" },
  { path: "members", select: "firstName lastName email profileImage role jobTitle" },
];

/** Prevents dangling references: department and every user must exist. */
async function assertRefs(input: { departmentId?: string; leadId?: string | null; memberIds?: string[] }) {
  if (input.departmentId && !(await Department.exists({ _id: input.departmentId }))) {
    throw unprocessable("Department not found.", [{ path: "departmentId", message: "Select an existing department." }]);
  }
  const userIds = [...new Set([...(input.memberIds ?? []), ...(input.leadId ? [input.leadId] : [])])];
  if (userIds.length && (await User.countDocuments({ _id: { $in: userIds } })) !== userIds.length) {
    throw unprocessable("One or more users were not found.", [{ path: "memberIds", message: "Select existing users." }]);
  }
}

/** Keeps `User.team` in sync with team membership (a user belongs to at most one team). */
async function syncUserTeam(teamId: Types.ObjectId, memberIds: Types.ObjectId[]) {
  await User.updateMany({ team: teamId, _id: { $nin: memberIds } }, { team: null });
  if (memberIds.length) await User.updateMany({ _id: { $in: memberIds } }, { team: teamId });
  await Team.updateMany({ _id: { $ne: teamId }, members: { $in: memberIds } }, { $pull: { members: { $in: memberIds } } });
}

export const teamsRouter = Router();
teamsRouter.param("id", (req, res, next) => validateObjectIds("id")(req, res, next));

teamsRouter.get("/", requirePermission("teams:read"), async (req, res) => {
  const q = parseQuery(listQuery, req);
  const filter: QueryFilter<ITeam> = {};
  if (q.departmentId) filter.department = new Types.ObjectId(q.departmentId);
  const re = searchRegex(q.search);
  if (re) filter.name = re;
  const [items, total] = await Promise.all([
    Team.find(filter).populate(POPULATE).sort({ name: 1 }).skip(q.skip).limit(q.pageSize).lean(),
    Team.countDocuments(filter),
  ]);
  paginated(res, items.map(serializeTeam), { page: q.page, pageSize: q.pageSize, total });
});

teamsRouter.get("/:id", requirePermission("teams:read"), async (req, res) => {
  const team = await Team.findById(req.params.id).populate(POPULATE).lean();
  if (!team) throw notFound("Team");
  ok(res, serializeTeam(team));
});

teamsRouter.post("/", requirePermission("teams:manage"), async (req, res) => {
  const input = parseBody(teamInput, req);
  await assertRefs(input);
  const members = [...new Set([...input.memberIds, ...(input.leadId ? [input.leadId] : [])])].map((id) => new Types.ObjectId(id));
  const team = await Team.create({ name: input.name, description: input.description ?? null, department: input.departmentId, lead: input.leadId ?? null, members });
  await syncUserTeam(team._id, members);
  created(res, serializeTeam((await Team.findById(team._id).populate(POPULATE).lean())!), "Team created.");
});

teamsRouter.patch("/:id", requirePermission("teams:manage"), async (req, res) => {
  const input = parseBody(teamInput.partial(), req);
  await assertRefs(input);
  const team = await Team.findById(req.params.id);
  if (!team) throw notFound("Team");
  if (input.name !== undefined) team.name = input.name;
  if (input.description !== undefined) team.description = input.description;
  if (input.departmentId !== undefined) team.department = new Types.ObjectId(input.departmentId);
  if (input.leadId !== undefined) team.lead = input.leadId ? new Types.ObjectId(input.leadId) : null;
  if (input.memberIds !== undefined) team.members = input.memberIds.map((id) => new Types.ObjectId(id));
  if (team.lead && !team.members.some((m) => String(m) === String(team.lead))) team.members.push(team.lead);
  await team.save();
  await syncUserTeam(team._id, team.members);
  ok(res, serializeTeam((await Team.findById(team._id).populate(POPULATE).lean())!), "Team updated.");
});

teamsRouter.delete("/:id", requirePermission("teams:manage"), async (req, res) => {
  const team = await Team.findByIdAndDelete(req.params.id);
  if (!team) throw notFound("Team");
  await User.updateMany({ team: team._id }, { team: null });
  noContent(res);
});
