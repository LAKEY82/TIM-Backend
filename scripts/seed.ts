/**
 * Development seed. WIPES the TIM collections in the configured database and
 * fills them with obviously fake sample data. Refuses to run in production.
 *
 *   npm run seed
 *
 * Every seeded account uses the password in SEED_PASSWORD (default below).
 */
import mongoose, { type Types } from "mongoose";
import { env } from "../src/config/env";
import { connectDatabase } from "../src/config/database";
import {
  Activity,
  Client,
  Comment,
  DailyTask,
  Department,
  FileModel,
  Milestone,
  Notification,
  PasswordReset,
  Project,
  Session,
  Setting,
  Task,
  Team,
  User,
} from "../src/models";
import { hashPassword } from "../src/services/auth.service";
import { recalcProjectStats } from "../src/services/project.service";
import { PRIORITY_RANK, type Priority, type Role, type TaskStatus, type TaskType } from "../src/types/domain";

const PASSWORD = process.env.SEED_PASSWORD ?? "Password123!";
const DAY = 864e5;
const day = (offset: number) => new Date(new Date().setUTCHours(0, 0, 0, 0) + offset * DAY);
const ago = (hours: number) => new Date(Date.now() - hours * 36e5);

async function main() {
  if (env.isProduction) throw new Error("Refusing to seed a production database (NODE_ENV=production).");
  await connectDatabase();
  console.log(`Seeding database "${mongoose.connection.name}"…`);

  await Promise.all(
    [Activity, Client, Comment, DailyTask, Department, FileModel, Milestone, Notification, PasswordReset, Project, Session, Setting, Task, Team, User].map((m) =>
      (m as typeof User).deleteMany({}),
    ),
  );
  // Build all indexes up front (unique email etc.).
  await Promise.all([User, Department, Client, Project, Task, Milestone, Notification, Activity, DailyTask, Comment, FileModel, Team, Session].map((m) => (m as typeof User).syncIndexes()));

  await Setting.create({ key: "company", name: "TIM Demo Company", timezone: "Asia/Colombo", workingHoursPerDay: 8, weekStartsOn: 1 });

  // --- departments --------------------------------------------------------
  const deptNames = ["Development", "UI/UX Design", "Marketing", "QA", "Management", "Administration"];
  const departments = await Department.insertMany(deptNames.map((name) => ({ name, description: `${name} department (sample data)` })));
  const dept = (name: string) => departments.find((d) => d.name === name)!._id;

  // --- users (fake) ---------------------------------------------------------
  const passwordHash = await hashPassword(PASSWORD);
  const people: [string, string, string, Role, string, string][] = [
    ["Alex", "Admin", "admin@tim.test", "ADMIN", "Administration", "System Administrator"],
    ["Casey", "Morgan", "ceo@tim.test", "CEO", "Management", "Chief Executive Officer"],
    ["Jordan", "Lee", "md@tim.test", "MANAGING_DIRECTOR", "Management", "Managing Director"],
    ["Priya", "Patel", "pm@tim.test", "PROJECT_MANAGER", "Development", "Project Manager"],
    ["Sam", "Rivera", "pm2@tim.test", "PROJECT_MANAGER", "Marketing", "Project Manager"],
    ["Taylor", "Kim", "devlead@tim.test", "DEPARTMENT_HEAD", "Development", "Head of Development"],
    ["Morgan", "Blake", "designlead@tim.test", "DEPARTMENT_HEAD", "UI/UX Design", "Head of Design"],
    ["Ava", "Chen", "ava@tim.test", "EMPLOYEE", "Development", "Software Engineer"],
    ["Noah", "Fischer", "noah@tim.test", "EMPLOYEE", "Development", "Software Engineer"],
    ["Mia", "Santos", "mia@tim.test", "EMPLOYEE", "UI/UX Design", "Product Designer"],
    ["Liam", "Okafor", "liam@tim.test", "EMPLOYEE", "Marketing", "Marketing Specialist"],
    ["Zoe", "Novak", "zoe@tim.test", "EMPLOYEE", "QA", "QA Engineer"],
    ["Ethan", "Brooks", "ethan@tim.test", "EMPLOYEE", "Development", "Mobile Developer"],
  ];
  const users = await User.insertMany(
    people.map(([firstName, lastName, email, role, department, jobTitle]) => ({ firstName, lastName, email, role, department: dept(department), jobTitle, passwordHash })),
  );
  const u = (email: string) => users.find((x) => x.email === email)!._id;
  await Department.updateOne({ _id: dept("Development") }, { head: u("devlead@tim.test") });
  await Department.updateOne({ _id: dept("UI/UX Design") }, { head: u("designlead@tim.test") });
  await Department.updateOne({ _id: dept("Management") }, { head: u("ceo@tim.test") });

  await Team.create({ name: "Web Platform", department: dept("Development"), lead: u("devlead@tim.test"), members: [u("devlead@tim.test"), u("ava@tim.test"), u("noah@tim.test")] });
  await User.updateMany({ _id: { $in: [u("devlead@tim.test"), u("ava@tim.test"), u("noah@tim.test")] } }, { team: (await Team.findOne())!._id });

  // --- clients (fake) -------------------------------------------------------
  const clients = await Client.insertMany([
    { name: "Acme Travel Co.", contactName: "Rita Example", email: "rita@acme.example", industry: "Travel", retainers: [{ name: "Website support", status: "ACTIVE", startDate: day(-120), hoursPerMonth: 20 }] },
    { name: "Northwind Retail", contactName: "Omar Example", email: "omar@northwind.example", industry: "Retail" },
    { name: "Globex Learning", contactName: "Hana Example", email: "hana@globex.example", industry: "Education", retainers: [{ name: "LMS maintenance", status: "ACTIVE", startDate: day(-60), hoursPerMonth: 30 }] },
    { name: "Initech Logistics", contactName: "Bill Example", email: "bill@initech.example", industry: "Logistics", status: "ACTIVE" },
  ]);
  const client = (name: string) => clients.find((c) => c.name === name)!._id;

  // --- projects -------------------------------------------------------------
  const projectDefs: { name: string; client: string | null; status: string; priority: Priority; manager: string; members: string[]; dept: string; start: number; end: number }[] = [
    { name: "Acme Booking Portal", client: "Acme Travel Co.", status: "ACTIVE", priority: "HIGH", manager: "pm@tim.test", members: ["ava@tim.test", "noah@tim.test", "mia@tim.test", "zoe@tim.test"], dept: "Development", start: -40, end: 20 },
    { name: "Northwind Online Store", client: "Northwind Retail", status: "AT_RISK", priority: "URGENT", manager: "pm@tim.test", members: ["noah@tim.test", "ethan@tim.test", "zoe@tim.test"], dept: "Development", start: -60, end: 5 },
    { name: "Globex Learning Platform", client: "Globex Learning", status: "ACTIVE", priority: "MEDIUM", manager: "pm@tim.test", members: ["ava@tim.test", "mia@tim.test"], dept: "Development", start: -20, end: 45 },
    { name: "Initech Fleet Dashboard", client: "Initech Logistics", status: "PLANNING", priority: "MEDIUM", manager: "pm2@tim.test", members: ["ethan@tim.test"], dept: "Development", start: 7, end: 90 },
    { name: "Spring Campaign", client: "Northwind Retail", status: "ACTIVE", priority: "HIGH", manager: "pm2@tim.test", members: ["liam@tim.test", "mia@tim.test"], dept: "Marketing", start: -15, end: 15 },
    { name: "Internal HR Portal", client: null, status: "ON_HOLD", priority: "LOW", manager: "pm2@tim.test", members: ["noah@tim.test"], dept: "Development", start: -90, end: 30 },
    { name: "Company Website Refresh", client: null, status: "COMPLETED", priority: "MEDIUM", manager: "pm@tim.test", members: ["mia@tim.test", "ava@tim.test"], dept: "UI/UX Design", start: -120, end: -30 },
  ];
  const projects = await Project.insertMany(
    projectDefs.map((p) => ({
      name: p.name,
      description: `${p.name} (sample project).`,
      client: p.client ? client(p.client) : null,
      type: p.client ? "EXTERNAL" : "INTERNAL",
      status: p.status,
      priority: p.priority,
      manager: u(p.manager),
      qa: u("zoe@tim.test"),
      members: p.members.map(u),
      department: dept(p.dept),
      startDate: day(p.start),
      deadline: day(p.end),
      estimatedHours: 200,
      createdBy: u(p.manager),
    })),
  );

  // --- milestones -------------------------------------------------------------
  const milestones = await Milestone.insertMany(
    projects.flatMap((p, i) => [
      { project: p._id, name: "Discovery & design", status: "COMPLETED", startDate: day(projectDefs[i]!.start), dueDate: day(projectDefs[i]!.start + 14), completedAt: day(projectDefs[i]!.start + 13) },
      { project: p._id, name: "Build", status: p.status === "COMPLETED" ? "COMPLETED" : "IN_PROGRESS", startDate: day(projectDefs[i]!.start + 15), dueDate: day(projectDefs[i]!.end - 5) },
      { project: p._id, name: "Launch", status: p.status === "COMPLETED" ? "COMPLETED" : "PENDING", startDate: day(projectDefs[i]!.end - 5), dueDate: day(projectDefs[i]!.end) },
    ]),
  );
  const buildMilestone = (projectId: Types.ObjectId) => milestones.find((m) => String(m.project) === String(projectId) && m.name === "Build")!._id;

  // --- tasks --------------------------------------------------------------------
  type T = [project: number, title: string, status: TaskStatus, priority: Priority, type: TaskType, assignee: string, due: number, est: number];
  const taskDefs: T[] = [
    [0, "Checkout API", "IN_REVIEW", "HIGH", "FEATURE", "ava@tim.test", 1, 8],
    [0, "Booking calendar UI", "IN_PROGRESS", "HIGH", "FEATURE", "noah@tim.test", 0, 6],
    [0, "Payment provider integration", "TODO", "URGENT", "FEATURE", "ava@tim.test", 3, 10],
    [0, "Search results design", "APPROVED", "MEDIUM", "DESIGN", "mia@tim.test", -5, 5],
    [0, "Booking flow regression tests", "TODO", "MEDIUM", "TEST", "zoe@tim.test", 6, 4],
    [0, "Fix date picker timezone bug", "CHANGES_REQUESTED", "HIGH", "BUG", "noah@tim.test", -1, 3],
    [1, "Product catalogue import", "BLOCKED", "URGENT", "FEATURE", "noah@tim.test", -3, 8],
    [1, "Cart and coupons", "IN_PROGRESS", "HIGH", "FEATURE", "ethan@tim.test", -2, 6],
    [1, "Mobile checkout layout", "TODO", "HIGH", "DESIGN", "ethan@tim.test", 2, 5],
    [1, "Order emails", "COMPLETED", "MEDIUM", "FEATURE", "noah@tim.test", -8, 4],
    [1, "Cart rounding bug", "TODO", "URGENT", "BUG", "zoe@tim.test", -1, 2],
    [2, "Course player", "IN_PROGRESS", "MEDIUM", "FEATURE", "ava@tim.test", 7, 12],
    [2, "Quiz engine", "TODO", "MEDIUM", "FEATURE", "ava@tim.test", 14, 10],
    [2, "Learner dashboard wireframes", "IN_REVIEW", "MEDIUM", "DESIGN", "mia@tim.test", 0, 6],
    [3, "Requirements workshop", "TODO", "MEDIUM", "MEETING", "ethan@tim.test", 9, 3],
    [4, "Campaign brief", "APPROVED", "HIGH", "CAMPAIGN", "liam@tim.test", -6, 4],
    [4, "Social media calendar", "IN_PROGRESS", "HIGH", "CONTENT", "liam@tim.test", 1, 6],
    [4, "Campaign landing page visuals", "TODO", "MEDIUM", "DESIGN", "mia@tim.test", 4, 5],
    [5, "Leave request form", "TODO", "LOW", "FEATURE", "noah@tim.test", 20, 6],
    [6, "Homepage redesign", "APPROVED", "MEDIUM", "DESIGN", "mia@tim.test", -40, 8],
    [6, "Website content migration", "COMPLETED", "MEDIUM", "CONTENT", "ava@tim.test", -35, 6],
  ];
  const reviewer = (projectIndex: number) => projects[projectIndex]!.manager!;
  const assigneeDept = new Map(users.map((x) => [String(x._id), x.department]));

  const tasks = await Task.insertMany(
    taskDefs.map(([pi, title, status, priority, type, assignee, due, est], i) => {
      const project = projects[pi]!;
      const done = status === "COMPLETED" || status === "APPROVED";
      const submitted = ["IN_REVIEW", "CHANGES_REQUESTED", "APPROVED"].includes(status);
      const reviewHistory = submitted
        ? [
            { decision: "SUBMITTED", actor: u(assignee), createdAt: ago(30 + i), feedback: null },
            ...(status === "APPROVED" ? [{ decision: "APPROVED", actor: reviewer(pi), createdAt: ago(20 + i), feedback: "Looks good." }] : []),
            ...(status === "CHANGES_REQUESTED" ? [{ decision: "CHANGES_REQUESTED", actor: reviewer(pi), createdAt: ago(20 + i), feedback: "Please handle the daylight-saving edge case." }] : []),
          ]
        : [];
      return {
        title,
        description: `${title} (sample task).`,
        project: project._id,
        milestone: buildMilestone(project._id),
        assignee: u(assignee),
        reviewer: reviewer(pi),
        createdBy: project.manager,
        department: assigneeDept.get(String(u(assignee))) ?? project.department,
        status,
        priority,
        priorityRank: PRIORITY_RANK[priority],
        type,
        tags: type === "BUG" ? ["bug"] : [],
        startDate: day(due - 5),
        dueDate: day(due),
        estimatedHours: est,
        actualHours: done ? est + (i % 3) - 1 : status === "IN_PROGRESS" ? Math.round(est / 2) : 0,
        completedAt: done ? day(due - 1) : null,
        reviewHistory,
        createdAt: ago(24 * (40 - (i % 30))),
      };
    }),
  );
  const task = (title: string) => tasks.find((t) => t.title === title)!;

  // Subtasks are ordinary tasks with a parent.
  const parent = task("Payment provider integration");
  await Task.insertMany(
    [
      ["Create sandbox account", "COMPLETED"],
      ["Webhook handler", "TODO"],
    ].map(([title, status]) => ({
      title,
      project: parent.project,
      parent: parent._id,
      assignee: parent.assignee,
      reviewer: parent.reviewer,
      createdBy: parent.createdBy,
      department: parent.department,
      status,
      priority: "MEDIUM",
      priorityRank: 1,
      type: "FEATURE",
      completedAt: status === "COMPLETED" ? day(-1) : null,
    })),
  );
  for (const p of projects) await recalcProjectStats(p._id);

  // --- comments, daily plan, notifications, activity ----------------------------
  const checkout = task("Checkout API");
  await Comment.insertMany([
    { entityType: "TASK", entityId: checkout._id, author: u("ava@tim.test"), body: "Implemented totals and tax. @PriyaPatel ready for a look.", mentions: [u("pm@tim.test")], createdAt: ago(31) },
    { entityType: "TASK", entityId: checkout._id, author: u("pm@tim.test"), body: "Thanks! Reviewing this afternoon.", mentions: [], createdAt: ago(29) },
  ]);

  const today = new Date().toISOString().slice(0, 10);
  await DailyTask.insertMany([
    { date: today, task: task("Booking calendar UI")._id, assignee: u("noah@tim.test"), assignedBy: u("pm@tim.test"), priority: "HIGH", estimatedHours: 4, dueTime: "15:00", note: "Focus on the month view first." },
    { date: today, task: task("Course player")._id, assignee: u("ava@tim.test"), assignedBy: u("pm@tim.test"), priority: "MEDIUM", estimatedHours: 3 },
  ]);

  await Notification.insertMany([
    { recipient: u("pm@tim.test"), actor: u("ava@tim.test"), type: "REVIEW_REQUESTED", title: "Ava Chen submitted Checkout API for review", entityType: "TASK", entityId: checkout._id, createdAt: ago(30) },
    { recipient: u("pm@tim.test"), actor: u("ava@tim.test"), type: "MENTION", title: "Ava Chen mentioned you on Checkout API", entityType: "TASK", entityId: checkout._id, createdAt: ago(31) },
    { recipient: u("noah@tim.test"), actor: u("pm@tim.test"), type: "CHANGES_REQUESTED", title: "Priya Patel requested changes on Fix date picker timezone bug", body: "Please handle the daylight-saving edge case.", entityType: "TASK", entityId: task("Fix date picker timezone bug")._id, createdAt: ago(20) },
    { recipient: u("ava@tim.test"), actor: u("pm@tim.test"), type: "TASK_ASSIGNED", title: "Priya Patel assigned Payment provider integration to you", entityType: "TASK", entityId: parent._id, createdAt: ago(48), readAt: ago(40) },
  ]);

  await Activity.insertMany([
    { actor: u("pm@tim.test"), type: "TASK_ASSIGNED", verb: "assigned", entityType: "TASK", entityId: checkout._id, entityName: checkout.title, target: { type: "USER", id: u("ava@tim.test"), name: "Ava Chen" }, project: checkout.project, createdAt: ago(60) },
    { actor: u("ava@tim.test"), type: "TASK_SUBMITTED", verb: "submitted for review", entityType: "TASK", entityId: checkout._id, entityName: checkout.title, project: checkout.project, createdAt: ago(30) },
    { actor: u("pm@tim.test"), type: "TASK_CHANGES_REQUESTED", verb: "requested changes on", entityType: "TASK", entityId: task("Fix date picker timezone bug")._id, entityName: "Fix date picker timezone bug", project: projects[0]!._id, createdAt: ago(20) },
    { actor: u("noah@tim.test"), type: "TASK_STATUS_CHANGED", verb: "marked as blocked", entityType: "TASK", entityId: task("Product catalogue import")._id, entityName: "Product catalogue import", project: projects[1]!._id, metadata: { from: "IN_PROGRESS", to: "BLOCKED" }, createdAt: ago(50) },
  ]);

  console.log(`Seeded ${users.length} users, ${departments.length} departments, ${clients.length} clients, ${projects.length} projects, ${await Task.countDocuments()} tasks.`);
  console.log(`All accounts use the password: ${PASSWORD}`);
  console.table(people.map(([first, last, email, role]) => ({ name: `${first} ${last}`, email, role })));
}

main()
  .then(() => mongoose.disconnect())
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await mongoose.disconnect();
    process.exit(1);
  });
