# TIM Backend

This is the REST API for **TIM**, the project and task management platform. It is built with Node.js, Express 5, TypeScript, MongoDB (Atlas) and Mongoose, and it serves the TIM frontend in `../frontend`.

- **Contract.** The API contract is derived from the frontend's services and types. [`BACKEND_SPEC.md`](BACKEND_SPEC.md) gives the full entity, endpoint and response-shape specification.
- **Authority.** The backend is the single source of truth for data **and permissions**. The frontend's permission checks only decide what the UI shows; the server enforces every rule on its own.

---

## 1. Installation

Requirements: **Node.js ≥ 20.19** (developed on Node 24) and a MongoDB database (MongoDB Atlas, or a local `mongod` for development).

```bash
cd backend
npm install
cp .env.example .env      # then fill in the values (see below)
```

## 2. Environment variables

All variables are validated at startup. A missing or invalid value stops the server with a clear message, and secret values are never printed.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `NODE_ENV` | | `development` | `development` / `test` / `production` |
| `PORT` | | `5000` | HTTP port (Render sets this automatically) |
| `MONGODB_URI` | **yes** | | Atlas connection string |
| `MONGODB_DB_NAME` | | from URI | Database name |
| `JWT_ACCESS_SECRET` | **yes** | | ≥ 32 chars, signs 15-minute access tokens |
| `JWT_REFRESH_SECRET` | **yes** | | ≥ 32 chars, **different** from the access secret |
| `ACCESS_TOKEN_TTL` | | `15m` | Access-token lifetime |
| `REFRESH_TOKEN_TTL_DAYS` | | `7` | Refresh-token / session lifetime |
| `CLIENT_URL` | **yes** | | Frontend origin(s), comma-separated. Used for the CORS allow-list and for email links |
| `COOKIE_DOMAIN` | | | Only if frontend and API share a parent domain |
| `COOKIE_SAMESITE` | | `none` in production, else `lax` | Refresh-cookie SameSite |
| `TRUST_PROXY` | | `0` | Number of proxies in front of the API (**set `1` on Render**) |
| `BCRYPT_ROUNDS` | | `12` | Password hashing cost (10–15) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE`, `MAIL_FROM` | | | Email for password-reset and invite links |
| `STORAGE_BUCKET`, `STORAGE_REGION`, `STORAGE_ENDPOINT`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, `STORAGE_PUBLIC_URL`, `STORAGE_FORCE_PATH_STYLE` | | | S3-compatible storage for attachments |
| `API_PUBLIC_URL` | | `http://localhost:PORT` | This API's public URL, used for links to files stored in MongoDB |
| `MAX_UPLOAD_MB` | | `25` | Upload size limit |
| `ENABLE_JOBS` | | `false` | Hourly "deadline approaching" notifications |
| `LOG_REQUESTS` | | `false` | Log every request in production (always on in development) |

To generate secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Without SMTP, reset and invite links are **logged to the console in development only**. In production nothing is sent until SMTP is configured.

Without a bucket, uploads are kept in **MongoDB (GridFS)** and served from `/api/storage/<key>` (set `API_PUBLIC_URL` to this API's public URL in production). That suits small teams and screenshots; configure a bucket for heavier use, since Atlas storage is limited. See §10.

## 3. MongoDB Atlas setup

1. Create a free **M0** cluster at <https://cloud.mongodb.com>.
2. **Database Access:** add a database user with a strong password and the *Read and write to any database* role. You can scope it to the `tim` database.
3. **Network Access:** add your development IP. For Render's free tier, which has no static IPs, allow `0.0.0.0/0` and rely on the strong password plus TLS. A paid tier can use static IPs or private networking instead.
4. **Connect → Drivers:** copy the `mongodb+srv://…` URI into `MONGODB_URI`, and set `MONGODB_DB_NAME=tim`.

Indexes are created automatically on startup. They are listed in `BACKEND_SPEC.md` §4.

## 4. Local development

```bash
npm run dev        # tsx watch, restarts on changes → http://localhost:5000
```

`GET /api/health` returns `{ status: "ok", db: "connected" }` once MongoDB is reachable.

Other scripts:

| Script | What it does |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start` | Run the compiled server (`node dist/server.js`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (typescript-eslint) |
| `npm run test` | Vitest + Supertest against an in-memory MongoDB |
| `npm run seed` | Wipe and seed the development database |

## 5. Database seeding

```bash
npm run seed
```

The seed **wipes** the TIM collections in the configured database, then inserts clearly fake sample data:
- 13 users across all roles
- 6 departments and 1 team
- 4 clients and 7 projects with milestones
- 23 tasks, including subtasks and review history
- comments, a daily plan, notifications and activity

It refuses to run when `NODE_ENV=production`.

**Development logins.** These are fake accounts; every one uses the password **`Password123!`** (override it with `SEED_PASSWORD`).

| Email | Role |
|---|---|
| `admin@tim.test` | ADMIN |
| `ceo@tim.test` | CEO |
| `md@tim.test` | MANAGING_DIRECTOR |
| `pm@tim.test`, `pm2@tim.test` | PROJECT_MANAGER |
| `devlead@tim.test`, `designlead@tim.test` | DEPARTMENT_HEAD |
| `ava@`, `noah@`, `mia@`, `liam@`, `zoe@`, `ethan@tim.test` | EMPLOYEE |

## 6. Authentication

```
POST /api/auth/login    → { user (with permissions), accessToken }  + Set-Cookie: tim_rt (httpOnly)
Authorization: Bearer <accessToken>          (15 min; the frontend keeps it in memory only)
POST /api/auth/refresh  → { accessToken }  + rotated cookie        (on 401, or on page load)
POST /api/auth/logout   → 204, session revoked, cookie cleared
```

**Refresh token.** A JWT valid for 7 days.
- **Storage:** it travels only in an `HttpOnly` cookie limited to `Path=/api/auth`. The cookie is `Secure; SameSite=None` in production and `SameSite=Lax` in development.
- **Sessions:** each sign-in creates a row in the `sessions` collection. Only a SHA-256 hash of the current token id is stored.
- **Rotation:** every refresh issues a new token. Presenting an old one (a replay) **revokes the session**.

**Checked on every request.** The access token's signature, issuer, audience and expiry are verified. In addition:
- the user must still exist and be `ACTIVE`
- the session must not be revoked
- the password must not have changed since the token was issued

The role is read from the database rather than from the token, so role changes and deactivations take effect immediately.

**CSRF.** `/refresh` and `/logout`, which authenticate by cookie, reject any `Origin` header not in `CLIENT_URL`.

**Rate limits.**
- **Login:** 10 per 15 minutes, keyed by IP and email.
- **Forgot/reset password:** 10 per 15 minutes, keyed by IP and email.
- **Refresh:** 120 per 15 minutes per session.

These are keyed per account or per session, not per IP alone, because offices share NAT IPs.

**Passwords.** Hashed with bcrypt (cost 12). Rules: 8 or more characters, at least one letter and one number. Hashes are never selected by default and are never serialized.

**Reset and invite links.** These use single-use random tokens stored only as hashes. Reset links are valid for 1 hour and invite links for 7 days. A successful reset revokes every session. Users created without a password receive an invite link.

## 7. API endpoints

All responses use one of these envelopes:

```jsonc
{ "success": true, "data": … , "message"?: "…" }
{ "success": true, "data": [ … ], "meta": { "page": 1, "pageSize": 20, "limit": 20, "total": 57, "totalPages": 3 } }
{ "success": false, "message": "…", "errors": [{ "path": "dueDate", "message": "…" }], "code"?: "VALIDATION_FAILED" }
```

**Pagination.** Lists take `?page=` plus `?pageSize=` or `?limit=`. The default page size is 20. The maximum is 100, except users (200), projects (200) and tasks (500, for boards and calendars).

**Request and response shapes.** These are in `BACKEND_SPEC.md` §5–6.

**Auth:** `/api/auth`

| Method | Path | Access |
|---|---|---|
| POST | `/api/auth/login` | public |
| POST | `/api/auth/refresh` | refresh cookie |
| POST | `/api/auth/logout` | refresh cookie |
| GET | `/api/auth/me` | signed in |
| POST | `/api/auth/forgot-password` | public |
| POST | `/api/auth/reset-password` | public |
| POST | `/api/auth/change-password` | signed in |

**Users, departments and teams**

| Method | Path | Access |
|---|---|---|
| GET | `/api/users?search&role&departmentId&status&page&pageSize` | signed in |
| POST | `/api/users` | `users:manage` |
| GET | `/api/users/:id` | signed in |
| PATCH | `/api/users/:id` | self (name, jobTitle, phone, profileImage) or `users:manage` |
| GET | `/api/users/:id/workload` | self, `teams:read` or `analytics:read` |
| GET | `/api/departments` | signed in |
| GET | `/api/departments/:id` | signed in |
| POST, PATCH, DELETE | `/api/departments[/:id]` | `departments:manage` |
| GET | `/api/teams[/:id]` | `teams:read` |
| POST, PATCH, DELETE | `/api/teams[/:id]` | `teams:manage` |

**Projects and milestones**

| Method | Path | Access |
|---|---|---|
| GET | `/api/projects?search&status&clientId&managerId&memberId&departmentId&sortBy&sortOrder&page&pageSize` | scoped |
| POST | `/api/projects` | `projects:create` |
| GET | `/api/projects/:id` | project access |
| PATCH | `/api/projects/:id` | project manager or company-wide `projects:update` |
| DELETE | `/api/projects/:id` | `projects:delete` (409 if tasks exist) |
| GET | `/api/projects/:id/members` | project access |
| POST | `/api/projects/:id/members` | manage |
| DELETE | `/api/projects/:id/members/:userId` | manage |
| GET | `/api/projects/:id/files` | project access |
| POST | `/api/projects/:id/files` | project access |
| GET | `/api/milestones?projectId&from&to` | scoped |
| POST, PATCH, DELETE | `/api/milestones[/:id]` | project manage |

**Tasks**

| Method | Path | Access |
|---|---|---|
| GET | `/api/tasks?projectId&milestoneId&parentId&assigneeId(=me)&reviewerId(=me)&departmentId&status(repeatable)&priority&overdue&dueFrom&dueTo&search&sortBy&sortOrder&page&pageSize` | scoped |
| GET | `/api/tasks/my-day?date=yyyy-MM-dd` | own tasks |
| POST | `/api/tasks` | `tasks:create` + project access (`parentId` creates a subtask) |
| GET | `/api/tasks/:id` | task access |
| PATCH | `/api/tasks/:id` | `tasks:assign` in scope; assignee may log `actualHours` only |
| DELETE | `/api/tasks/:id` | `tasks:delete` in scope (cascades subtasks, comments and files) |
| PATCH | `/api/tasks/:id/status` | see §8 |
| POST | `/api/tasks/:id/submit` | assignee or manager |
| POST | `/api/tasks/:id/approve` | reviewer (never the assignee) |
| POST | `/api/tasks/:id/request-changes` | reviewer; `feedback` is required |
| GET | `/api/tasks/:id/reviews` | task access |
| GET | `/api/tasks/:id/comments` | task access |
| POST | `/api/tasks/:id/comments` | task access |
| PATCH | `/api/tasks/:id/comments/:commentId` | author |
| DELETE | `/api/tasks/:id/comments/:commentId` | author or task manager |
| POST | `/api/tasks/:id/attachments` | task access (multipart `file`) |
| DELETE | `/api/tasks/:id/attachments/:attachmentId` | uploader or task manager |
| GET, DELETE | `/api/files/:id` | access to the owning task or project |

**Everything else**

| Method | Path | Access |
|---|---|---|
| GET | `/api/daily-tasks?date&assigneeId` | `daily_tasks:manage`, or own plan |
| GET | `/api/daily-tasks/workload?date` | `daily_tasks:manage` |
| POST, DELETE | `/api/daily-tasks[/:id]` | `daily_tasks:manage` |
| GET | `/api/notifications?page&pageSize&unreadOnly` | own |
| GET | `/api/notifications/unread-count` | own |
| PATCH | `/api/notifications/read-all` | own |
| PATCH | `/api/notifications/:id/read` | own |
| DELETE | `/api/notifications/:id` | own |
| GET | `/api/activity?entityType&entityId&projectId&userId&departmentId&clientId&limit&page` | scoped, read-only |
| GET | `/api/clients[/:id]` | `clients:read` |
| POST, PATCH, DELETE | `/api/clients[/:id]` | `clients:manage` |
| GET | `/api/search?q=` | scoped (5 of each type) |
| GET | `/api/analytics/company?from&to` | `analytics:company` |
| GET | `/api/analytics/projects/:id` | project access |
| GET | `/api/analytics/departments/:id?from&to` | `analytics:read` or `teams:read` (department heads: own department) |
| GET | `/api/analytics/tasks?from&to` | `analytics:read` (scoped) |
| GET | `/api/analytics/workload?departmentId&projectId&managerId` | `analytics:read` or `teams:read` |
| GET | `/api/settings/company` | signed in |
| PATCH | `/api/settings/company` | `settings:company` |
| GET, PUT | `/api/settings/notifications` | own preferences |
| GET | `/api/health` | public |

## 8. Roles and permissions

There are six roles: `ADMIN`, `CEO`, `MANAGING_DIRECTOR`, `PROJECT_MANAGER`, `DEPARTMENT_HEAD` and `EMPLOYEE`. The role-to-permission matrix lives in [`src/config/permissions.ts`](src/config/permissions.ts) and is reproduced in `BACKEND_SPEC.md` §2.

It uses the **frontend's own permission names**, such as `tasks:review` and `users:manage`. `/api/auth/me` returns the list, and the UI gates on it, so the server and UI cannot drift apart.

Enforcement has two layers:

1. **Permissions:** `requirePermission(...)` and `requireAnyPermission(...)` route middleware.
2. **Data scope:** this lives in [`src/services/access.service.ts`](src/services/access.service.ts).

**Who sees what.**

| Who | Sees |
|---|---|
| Company-wide roles | All projects |
| Everyone else | Projects they manage or belong to, projects whose tasks they are assigned to or review, and (for department heads) their department's projects |

Lists are filtered by this scope, and single records outside it return **404**, so they don't reveal that the record exists. The `requireProjectAccess("read" | "manage")` middleware loads and checks projects; task routes use the same rules.

**Task workflow.**

| Action | Who can do it |
|---|---|
| Move between TODO, IN_PROGRESS, BLOCKED and COMPLETED | The assignee, along allowed transitions only |
| Set any status | Managers with `tasks:assign` in scope |
| Submit for review (to `IN_REVIEW`) | The assignee or a manager |
| Approve or request changes | The designated reviewer, or `tasks:review` in scope, and **never the assignee** |

Requesting changes always requires written feedback. Every review decision is stored in the task's review history.

## 9. Deployment (Render + Vercel + Atlas)

**Backend on Render** (free web service):
- Root directory: `backend`
- Build command: `npm ci && npm run build`
- Start command: `npm run start`
- Health check path: `/api/health`
- Environment: `NODE_ENV=production`, `TRUST_PROXY=1`, `MONGODB_URI`, `MONGODB_DB_NAME`, both JWT secrets, `CLIENT_URL=https://<your-app>.vercel.app`, plus SMTP and STORAGE values when ready.

**Frontend on Vercel:**
- Set `NEXT_PUBLIC_API_URL=https://<your-api>.onrender.com`.
- It is inlined at build time, so redeploy after changing it.
- Do **not** set `NEXT_PUBLIC_AUTH_DISABLED` there. Preview mode only works under `next dev` anyway.

**Cookies.** Vercel and Render are different sites, so the refresh cookie is `SameSite=None; Secure`. That is the production default. If a browser blocks third-party cookies, put the API on a subdomain of the frontend's domain (for example `api.example.com` and `app.example.com`), then set `COOKIE_DOMAIN=example.com` and `COOKIE_SAMESITE=lax`.

**Free-tier notes.**
- Render's free instances sleep when idle, so the first request after a sleep takes about 30 seconds.
- The background reminder job (`ENABLE_JOBS`) only runs while the instance is awake.

**Moving to a paid server.** Nothing in the code is Render-specific. The server is stateless, sessions are in MongoDB and files are in object storage, so you can run several instances behind a load balancer. Two things change with scale:
- The in-memory rate-limit counters are per instance. Use a shared store (Redis) for strict limits across instances.
- With several instances, enable `ENABLE_JOBS` on one of them only (the reminder claims are atomic anyway).

## 10. Security considerations

- **Headers and CORS.** Helmet sets a strict CSP (`default-src 'none'`; this is a JSON API), HSTS and nosniff, and the `x-powered-by` header is disabled. CORS uses an explicit allow-list with credentials.
- **Validation.** Every body, query and param is parsed by **Zod** into primitives or ObjectIds before it reaches MongoDB, which blocks operator injection. Express 5's simple query parser also never builds nested objects from query strings. Invalid ids return 400.
- **Request limits.** JSON bodies are limited to 1 MB. Uploads are limited to 25 MB, must match a MIME allow-list (no HTML, SVG or executables), and are held in memory, never written to disk.
- **Errors.** Error responses never include stack traces or internals. Duplicate keys map to 409, cast errors to 400, validation to 422, and unexpected errors to a generic 500 that is logged server-side.
- **Secrets.** Secrets come from the environment only. `.env` is git-ignored. Logs never print secrets, tokens, password hashes or reset links (except dev-mode email logging).
- **Audit trail.** The activity log is append-only: model-level updates are blocked and there is no HTTP endpoint to edit it.
- **File storage.** Uploads are never written to the server's disk. Without a bucket they are stored in MongoDB (GridFS) and served at unguessable `/api/storage/...` URLs, like a public bucket. With one, uploads go to S3-compatible object storage (AWS S3, Cloudflare R2, Supabase Storage via its S3 API, MinIO). Render's disk is ephemeral, so local files would disappear on every deploy or restart. With a private bucket, download links are 1-hour presigned URLs; set `STORAGE_PUBLIC_URL` only for a public or CDN bucket.

## Tests

`npm run test` starts an **in-memory MongoDB** (`mongodb-memory-server`, which downloads `mongod` on first run) and exercises the real Express app through Supertest. The 44 tests cover:
- **Login:** shape, cookie flags, wrong or unknown credentials, inactive accounts, validation.
- **Sessions:** `/me`, deactivation, refresh rotation and replay detection, CSRF origin check, logout revocation.
- **Passwords:** the full reset flow, and change-password signing out other devices.
- **Permissions:** 403s per role, self-edit limits, admin user management, immediate role changes.
- **Project scoping:** 404 for non-members, project managers limited to their own projects.
- **Projects:** create/validate, list with search, filter, sort and pagination, members.
- **Tasks:** create/assign plus notifications, assignee-only hours, and the full review workflow including rejection paths.
- **Task lists and views:** filters, subtasks, My Day, delete cascade.
- **Comments:** mentions and edit/delete rights.
- **Notifications:** list, count, read and read-all, and preferences.
- **Other areas:** scoped search, activity shape, analytics access, uploads (503 without storage, storage provider flow, MongoDB fallback, MIME rejection), and the error formats.

---

## 11. Project structure

```
backend/
├── src/
│   ├── server.ts          Entry point: connects MongoDB, starts HTTP server and jobs, graceful shutdown
│   ├── app.ts             Builds the Express app: security middleware, router mounting, error handlers
│   ├── config/
│   │   ├── env.ts         Zod-validated environment variables (the only place process.env is read)
│   │   ├── permissions.ts Role → permission matrix (single source of truth for authorization)
│   │   ├── database.ts    Mongoose connection helpers
│   │   ├── cors.ts        CORS allow-list built from CLIENT_URL
│   │   └── zod.ts         Global Zod settings (imported first in app.ts)
│   ├── models/            Mongoose schemas + TypeScript interfaces, re-exported from models/index.ts
│   ├── routes/            One Express Router per resource (*.routes.ts), mounted in app.ts
│   ├── services/          Business logic shared between routes (access scoping, tasks, auth, storage…)
│   ├── validators/        Reusable Zod schemas (common.ts has ids, dates, pagination, text helpers)
│   ├── middleware/        Auth, permissions, validation, uploads, error handling
│   ├── utils/             Response helpers (http.ts), errors (errors.ts), serializers, logger, staged workflow
│   ├── types/domain.ts    Enums shared everywhere: roles, statuses, priorities, notification types…
│   └── jobs/              Background jobs (hourly deadline reminders)
├── scripts/seed.ts        Development seed data
├── tests/                 Vitest + Supertest integration tests (helpers.ts has fixtures and login)
├── BACKEND_SPEC.md        Full API contract (entities, endpoints, response shapes)
└── dist/                  Build output (git-ignored)
```

**How a request flows.**
1. `app.ts` applies security middleware, then `requireAuth` for everything under `/api` except auth, health and storage.
2. The resource router runs `requirePermission(...)` (or an access check).
3. The handler parses input with Zod, applies the access scope from `access.service.ts`, and talks to the Mongoose models.
4. It replies with `ok` / `created` / `paginated` / `noContent` and a `serialize*` function.
5. Anything thrown (e.g. `throw notFound("Task")`) becomes the standard error envelope in `error.middleware.ts`. Express 5 forwards errors from `async` handlers automatically, so handlers need no `try/catch` or `next(err)`.

## 12. Changing and extending the backend

How to make the most common changes. Always finish with the checklist in §12.9.

### 12.1 Add a field to an existing entity

Example: add a `budget` number to projects.

1. **Model.** In [`src/models/Project.ts`](src/models/Project.ts), add the field to the `IProject` interface and the schema:
   ```ts
   budget?: number | null;                          // IProject interface
   budget: { type: Number, min: 0, default: null }, // schema
   ```
2. **Validation.** Add it to `projectFields` in [`src/validators/projects.validators.ts`](src/validators/projects.validators.ts), e.g. `budget: z.number().min(0).nullable().optional()`. Request schemas only let through the fields they list (several are `.strict()` and reject unknown fields with 422), so **a field that isn't in the validator can't be written**.
3. **Response.** Add it to `serializeProject` in [`src/utils/serialize.ts`](src/utils/serialize.ts), e.g. `budget: p.budget ?? null`. Serializers decide exactly what leaves the API; a field missing there is never returned.
4. **Frontend contract.** Update `BACKEND_SPEC.md` and the frontend type (`frontend/src/types/domain.ts`) so both sides agree.
5. **Seed and tests.** Add sample values to `scripts/seed.ts` if useful, plus a test assertion.

Optional fields need no migration: Mongoose applies the `default` to old documents when reading them. For a **required** field or a rename, write a one-off script (see `scripts/seed.ts` for how to connect) that runs `updateMany` on existing data.

### 12.2 Add an endpoint to an existing resource

Open the matching file in `src/routes/` and follow the existing pattern:

```ts
projectsRouter.get("/:id/summary", requireProjectAccess("read"), async (req, res) => {
  const q = parseQuery(z.object({ from: dayString.optional() }), req);
  const project = await Project.findById(routeParam(req, "id")).lean();
  if (!project) throw notFound("Project");
  ok(res, { id: String(project._id), name: project.name /* … */ });
});
```

Rules to keep:
- **Check access first.** Every route needs `requirePermission`, `requireAnyPermission` or an access check (`requireProjectAccess`, `accessibleTask`, …).
- **Validate everything.** Use `parseBody`, `parseQuery`, and `validateObjectIds` for params. Never pass `req.body` or `req.query` straight to Mongoose.
- **Scope lists.** Spread `projectScopeFilter(user)` / `taskScopeFilter(user)` into list queries so users only see what they're allowed to.
- **Out of scope means 404**, not 403, so the API doesn't reveal which records exist.
- **Use the helpers.** Responses go through `utils/http.ts`; errors come from the factories in `utils/errors.ts` (`badRequest`, `forbidden`, `notFound`, `conflict`, `unprocessable`, `serviceUnavailable`).
- **Mind route order.** Declare fixed paths (`/my-day`, `/unread-count`) **before** `/:id`.

### 12.3 Add a new resource

Example: an `expenses` resource.

1. **Enums** (if any) go in `src/types/domain.ts` as `as const` arrays, e.g. `export const EXPENSE_STATUSES = ["PENDING", "APPROVED"] as const;`.
2. **Model.** Create `src/models/Expense.ts`, using [`Client.ts`](src/models/Client.ts) as a template. Use `{ timestamps: true }`, add the indexes your queries need, and add `export * from "./Expense";` to `src/models/index.ts`.
3. **Serializer.** Add `serializeExpense` to `src/utils/serialize.ts`. Return `id` as a string (never `_id`) and dates as ISO strings.
4. **Router.** Create `src/routes/expenses.routes.ts`. [`clients.routes.ts`](src/routes/clients.routes.ts) is a compact CRUD example to copy, including the `router.param("id", …validateObjectIds("id")…)` line at the top.
5. **Mount** it in [`src/app.ts`](src/app.ts) with `api.use("/expenses", expensesRouter);`. Mounting on `api` makes it require sign-in.
6. **Permissions.** Add any new permission names (§12.4).
7. **Audit and notifications** (optional). Call `logActivity(...)` / `notify(...)` without awaiting them (`void logActivity(...)`). Both swallow their own errors, so they never break the request. A new activity entity type must be added to `ENTITY_TYPES`, and a new notification type to `NOTIFICATION_TYPES`.
8. **Docs, seed and tests.** Document the endpoints in §7 and in `BACKEND_SPEC.md`, and add a test file under `tests/`.

### 12.4 Change roles and permissions

Everything lives in [`src/config/permissions.ts`](src/config/permissions.ts):

- **New permission.** Add it to `PERMISSIONS`, then grant it to roles in `ROLE_PERMISSIONS` (`ADMIN` gets every permission automatically). Use the `resource:action` naming style.
- **Change what a role can do.** Edit that role's array in `ROLE_PERMISSIONS`. The change applies on the next request, because roles are read from the database every time.
- **New role.** Add it to `ROLES` in `src/types/domain.ts`, then add an entry to `ROLE_PERMISSIONS` (TypeScript errors until you do). Update the seed and the frontend's `ROLES` too.

The frontend gates its UI on the list from `/api/auth/me`. If the UI should react to a new permission, mirror it in `frontend/src/lib/permissions.ts`, and update the matrix in `BACKEND_SPEC.md` §2.

Rules that depend on *which* record is involved (e.g. "only this project's manager") belong in `src/services/access.service.ts`, not in the permission matrix.

### 12.5 Change the task workflow

- **Status values:** `TASK_STATUSES` in `src/types/domain.ts`.
- **What an assignee may change a status to:** `ASSIGNEE_TRANSITIONS` in [`src/services/task.service.ts`](src/services/task.service.ts). Submit, approve, request-changes and QA logic live in the same file.
- **The staged project workflow** (Design → Frontend + Backend → QA → Bug fixing): [`src/utils/workflow.ts`](src/utils/workflow.ts).

After a change, update the workflow tests in `tests/projects-tasks.test.ts`. A new status must also be added to the frontend's status lists and board columns.

### 12.6 Add an environment variable

1. Add it to the Zod schema in [`src/config/env.ts`](src/config/env.ts), with a default if it's optional (use the `bool` helper for flags).
2. Read it as `env.MY_VAR`. Don't read `process.env` anywhere else.
3. Add it to `.env.example` with a comment, and to the table in §2.
4. If tests need it, add it to `env` in `vitest.config.mts`.
5. Set it on Render (or your host) before deploying.

### 12.7 Add a background job

Follow [`src/jobs/deadline-reminders.ts`](src/jobs/deadline-reminders.ts): write a `run…()` function and schedule it inside `startJobs()` (clear it in `stopJobs()`). Keep the work idempotent and claim records atomically, because several instances may run it. Jobs only run when `ENABLE_JOBS=true`.

### 12.8 Write tests

Tests run the real app against an in-memory MongoDB. A minimal test file:

```ts
import type { Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { login, resetDb, seedFixture, startTestDb, stopTestDb } from "./helpers";

let app: Express;

beforeAll(async () => { app = await startTestDb(); });
afterAll(stopTestDb);
beforeEach(async () => { await resetDb(); await seedFixture(); });

describe("expenses", () => {
  it("lets admins create and blocks employees", async () => {
    const admin = await login(app, "admin@t.test");
    const emp = await login(app, "emp@t.test");
    expect((await admin.post("/api/expenses", { amount: 10 })).status).toBe(201);
    expect((await emp.post("/api/expenses", { amount: 10 })).status).toBe(403);
  });
});
```

What the helpers give you:
- **`seedFixture()`** creates one user per role, two departments and two projects, and returns their ids. The users are `admin@`, `ceo@`, `pm@`, `pm2@`, `head@`, `emp@`, `emp2@` and `outsider@t.test`.
- **`login()`** returns a session with `get` / `post` / `patch` / `put` / `del` methods.

For every new route, test at least:
- the happy path
- a forbidden role (403)
- an out-of-scope record (404)
- invalid input (400/422)

Run a single file with `npx vitest run tests/expenses.test.ts`, or use `npm run test:watch` while developing.

### 12.9 Checklist before you push

```bash
npm run typecheck && npm run lint && npm run test && npm run build
```

- [ ] New inputs are validated with Zod, and new routes have a permission or access check.
- [ ] New response fields go through a serializer.
- [ ] `README.md`, `BACKEND_SPEC.md` and `.env.example` are updated where relevant.
- [ ] The frontend types and services match, if the contract changed.
- [ ] No secrets or `.env` files are staged (check `git status` before committing).

## 13. Git workflow

```bash
git checkout -b feature/short-description   # work on a branch, not main
# …make changes, run the checklist above…
git add -A
git commit -m "Add budget field to projects"
git push -u origin feature/short-description
```

Then open a pull request into `main` on GitHub. If Render auto-deploys from `main`, only merge code that passes the checklist.
