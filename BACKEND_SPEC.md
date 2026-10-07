# TIM Backend Specification

This spec is derived from the TIM frontend (`../frontend`). The sources are:

- `src/lib/services/*.ts`: every API call, its query parameters and payloads.
- `src/lib/services/normalize.ts` and `analytics.ts`: the response shapes the UI can parse.
- `src/types/domain.ts`: the domain contract.
- `src/lib/permissions.ts`: the roles and the permission vocabulary.
- `src/lib/api.ts`: the auth flow and how errors and envelopes are handled.

When this spec and the frontend disagree, the frontend's actual calls win.

---

## 1. Conventions

| Topic | Contract |
|---|---|
| Base path | `/api/*` on the API origin (`NEXT_PUBLIC_API_URL` on the frontend) |
| Success | `{ "success": true, "data": <payload>, "message"?: string }` |
| Paginated success | `{ "success": true, "data": [...], "meta": { page, pageSize, limit, total, totalPages } }` |
| Error | `{ "success": false, "message": string, "errors": [{ "path": "field.sub", "message": string }] }` |
| IDs | Mongo ObjectIds serialized as `id` strings (never `_id`) |
| Dates | ISO 8601 strings; date-only filters use `yyyy-MM-dd` |
| Pagination | `page` (≥1) plus `pageSize` **or** `limit`. Default 20; max 100, raised per route where the UI needs whole sets (users 200, projects 200, tasks 500) |
| Sorting | `sortBy` + `sortOrder=asc|desc` (allow-listed per route) |
| No content | Mutations with nothing to return answer `204` |

The frontend's `unwrapEnvelope` accepts exactly these keys (`data`, `meta`, `success`, `message`). The frontend's `extractFieldErrors` reads `errors[].path`/`errors[].message`, which is how server validation errors appear inline on forms.

Status codes: 200, 201, 204, 400 (malformed), 401 (unauthenticated), 403 (forbidden), 404, 409 (conflict/duplicate), 413 (upload too large), 422 (validation), 429 (rate limit), 500, 503 (storage/mail not configured).

---

## 2. Roles and permissions

Roles are a fixed enum, matching `ROLES` in the frontend:

`ADMIN`, `CEO`, `MANAGING_DIRECTOR`, `PROJECT_MANAGER`, `DEPARTMENT_HEAD`, `EMPLOYEE`

The permission vocabulary is the frontend's own. `GET /api/auth/me` returns `user.permissions`, and the frontend uses that list verbatim for UI gating. The backend enforces the same permissions on every route.

| Permission | ADMIN | CEO | MD | PM | DEPT_HEAD | EMPLOYEE |
|---|---|---|---|---|---|---|
| dashboard:company | ✓ | ✓ | ✓ | | | |
| dashboard:operations | ✓ | ✓ | ✓ | | | |
| dashboard:team | ✓ | ✓ | ✓ | ✓ | ✓ | |
| projects:read_all | ✓ | ✓ | ✓ | | | |
| projects:create | ✓ | ✓ | ✓ | ✓ | | |
| projects:update | ✓ | ✓ | ✓ | ✓ (own projects) | | |
| projects:delete (backend addition) | ✓ | | | | | |
| tasks:read_all | ✓ | ✓ | ✓ | | | |
| tasks:create | ✓ | ✓ | ✓ | ✓ | ✓ | |
| tasks:assign | ✓ | ✓ | ✓ | ✓ | ✓ | |
| tasks:review | ✓ | ✓ | ✓ | ✓ | ✓ | |
| tasks:delete (backend addition) | ✓ | ✓ | ✓ | ✓ (own projects) | | |
| daily_tasks:manage | ✓ | ✓ | ✓ | ✓ | ✓ | |
| teams:read | ✓ | ✓ | ✓ | ✓ | ✓ | |
| teams:manage (backend addition) | ✓ | ✓ | ✓ | | | |
| clients:read | ✓ | ✓ | ✓ | ✓ | | |
| clients:manage | ✓ | ✓ | ✓ | | | |
| analytics:read | ✓ | ✓ | ✓ | ✓ | ✓ | |
| analytics:company | ✓ | ✓ | ✓ | | | |
| users:manage | ✓ | | | | | |
| departments:manage | ✓ | | | | | |
| settings:company | ✓ | ✓ | | | | |
| timeline:read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

**Scoped access.** Permissions alone are not enough. These rules are checked on every request.

**Projects.** A user can see a project in any of these cases:
- They have `projects:read_all`.
- They are its manager or a member.
- They are a department head of the project's department.
- They are assigned to, or review, a task in it.

Changing a project needs `projects:update`, plus either `projects:read_all` or being the project's manager.

**Tasks.** A user can see a task if they have `tasks:read_all`, or they can see its project, or they are its assignee, reviewer or creator. Their right to change it then depends on the action:
- **Edit any field:** `tasks:assign` within an accessible project.
- **Edit as the assignee:** the assignee can only log `actualHours`.
- **Status changes:** the assignee may move between TODO, IN_PROGRESS, BLOCKED and COMPLETED. Anyone with `tasks:assign` may set any status.
- **Review decisions:** the designated reviewer, or `tasks:review` within project access.

**Comments.** Only the author can edit a comment. The author, or anyone with `tasks:assign` on the task, can delete it.

**Users.** Any signed-in user may read basic profiles, because pickers and mentions need them. Users can edit their own name, job title, phone and avatar. Role, department, status and email changes require `users:manage`. Nobody can change their own role or status.

---

## 3. Authentication flow

```
login ──► 200 { user (incl. permissions), accessToken }   + Set-Cookie: tim_rt=<refresh JWT>; HttpOnly; Secure*; SameSite*; Path=/api/auth
request ─► Authorization: Bearer <accessToken>             (15 min TTL, kept in memory by the frontend)
401 ─────► POST /api/auth/refresh (cookie) ─► 200 { accessToken } + rotated cookie
logout ──► session revoked, cookie cleared
```

**Access token.** A JWT signed with `JWT_ACCESS_SECRET` (HS256), valid for 15 minutes. Claims: `sub` (user id), `sid` (session id), `role`.

**Refresh token.** A JWT signed with `JWT_REFRESH_SECRET`, valid for 7 days. Claims: `sub`, `sid` and `jti`.
- Only a SHA-256 hash of the current `jti` is stored, in the `sessions` collection.
- **Rotation:** every refresh issues a new `jti` and replaces the stored hash.
- **Reuse detection:** if a refresh token arrives with a stale `jti` for a live session, that session is revoked.

**Refresh cookie.** The cookie is `HttpOnly`, with `Path=/api/auth`. `Secure` is set in production. `SameSite` is `none` in production (Vercel and Render are different sites) and `lax` in development (`localhost` ports are the same site).

**CSRF protection.** Cookie-authenticated endpoints (`/refresh` and `/logout`) reject requests whose `Origin` is present but not in the CORS allow-list.

**Inactive accounts.** `INACTIVE` and `SUSPENDED` accounts cannot log in. Their sessions are revoked when their status changes, and access tokens are checked against the user's current status on every request.

**Password reset.** Each reset uses a single-use random token, stored only as a SHA-256 hash and valid for 1 hour. A successful reset revokes all of the user's sessions.

**Rate limits.** Login and forgot-password allow 10 requests per 15 minutes per IP and email; refresh allows 60 per 15 minutes.

---

## 4. Collections

| Collection | Key fields | Notes |
|---|---|---|
| users | firstName, lastName, email (unique, lowercase), passwordHash (`select:false`), profileImage, phone, jobTitle, role, department→departments, team→teams, status (ACTIVE/INACTIVE/SUSPENDED), lastLoginAt, notificationPreferences {email,inApp}, passwordChangedAt | API returns `name` = first + last |
| sessions | user, jtiHash, userAgent, ip, expiresAt (TTL), revokedAt | refresh-token store |
| passwordresets | user, tokenHash (unique), expiresAt (TTL), usedAt | |
| departments | name (unique, case-insensitive), description, head→users | counts computed |
| teams | name, description, department→departments, lead→users, members→users[] | backend addition; UI "Teams" = departments |
| clients | name, contactName, email, phone, website, industry, notes, status, retainers[] (embedded: name, status, startDate, endDate, hoursPerMonth) | |
| projects | name, description, client→clients, type (INTERNAL/EXTERNAL), status, priority, manager→users, members→users[], department→departments, startDate, deadline, estimatedHours, taskCount, completedTaskCount, progress | counters are denormalized and recalculated on every task change (sortable by progress) |
| milestones | project→projects, name, description, status, startDate, dueDate, completedAt | progress and taskCount computed from tasks |
| tasks | title, description, project, milestone, parent→tasks (subtasks), assignee, reviewer, createdBy, department, status, priority, priorityRank, type, tags[], startDate, dueDate, estimatedHours, actualHours, completedAt, watchers[], reviewHistory[] (embedded: decision, feedback, actor, createdAt) | subtasks are tasks with `parent` |
| comments | entityType (TASK/PROJECT), entityId, author, body, mentions[]→users, editedAt | |
| files | entityType (TASK/PROJECT), entityId, storageKey, url, fileName, size, mimeType, uploadedBy | binaries are in object storage |
| notifications | recipient, actor, type, title, body, entityType, entityId, readAt | `read` derived from `readAt` |
| activities | actor, type (machine key), verb (display text), entityType, entityId, entityName, target {type,id,name}, project, department, client, metadata | append-only (updates are blocked in the schema) |
| dailytasks | date (yyyy-MM-dd), task, assignee, assignedBy, priority, estimatedHours, dueTime, note | unique (date, assignee, task) |
| settings | key ("company"), name, timezone, workingHoursPerDay, weekStartsOn | singleton |

**Indexes.** Each index below serves a real query.

| Collection | Index | Serves |
|---|---|---|
| users | email (unique) | login |
| users | role | user filters |
| users | department | user filters, department members |
| users | status | user filters |
| users | text-like regex search on firstName, lastName, email | user search (small collection) |
| projects | status | status filter |
| projects | client | client filter, client detail |
| projects | members | visibility checks |
| projects | manager | visibility checks |
| projects | department | department filter |
| projects | deadline | sort, calendar |
| tasks | { project, status } | board, project task list |
| tasks | { assignee, status } | My Day, workload |
| tasks | reviewer | review queue |
| tasks | { dueDate, status } | overdue, calendar |
| tasks | priorityRank | priority sort |
| tasks | department | department views |
| tasks | parent | subtasks |
| tasks | milestone | milestone progress |
| tasks | createdAt | trends |
| tasks | completedAt | trends |
| milestones | { project, dueDate } | project milestones, calendar |
| comments | { entityType, entityId, createdAt } | comment threads |
| files | { entityType, entityId } | attachments |
| notifications | { recipient, readAt, createdAt } | unread count, list |
| activities | { entityType, entityId, createdAt } | entity history |
| activities | { project, createdAt } | project activity |
| activities | { actor, createdAt } | user activity |
| activities | createdAt | recent activity |
| sessions | expiresAt (TTL) | expiry cleanup |
| passwordresets | expiresAt (TTL) | expiry cleanup |
| dailytasks | { date, assignee } | daily plan |

---

## 5. Response shapes (what the frontend parses)

- **UserSummary:** `{ id, name, email, avatarUrl, role, jobTitle }`
- **User:** a UserSummary plus `{ firstName, lastName, phone, status: "ACTIVE"|"INACTIVE"|"SUSPENDED", departmentId, department: {id,name}|null, permissions: string[] (only on /auth/me and /auth/login), lastLoginAt, createdAt }`
- **Department:** `{ id, name, description, head: UserSummary|null, memberCount, activeTaskCount, projectCount }` (the detail response adds `members: User[]`)
- **Project:** `{ id, name, description, client: {id,name}|null, type, status, priority, manager, members: UserSummary[], department, startDate, deadline, progress, taskCount, completedTaskCount, estimatedHours, createdAt }`
- **TaskSummary:** `{ id, title, status, priority, type, project: {id,name}, milestone: {id,name}|null, assignee, reviewer, startDate, dueDate, estimatedHours, actualHours, subtaskCount, completedSubtaskCount, commentCount, tags, parentId }`
- **Task:** a TaskSummary plus `{ description, department, subtasks: [{id,title,status,assignee}], attachments: Attachment[], createdBy, createdAt, updatedAt, completedAt }`
- **ReviewEntry:** `{ id, decision: SUBMITTED|APPROVED|CHANGES_REQUESTED, feedback, actor, createdAt }`
- **Comment:** `{ id, taskId, body, author, mentions, createdAt, updatedAt, edited }`
- **Attachment:** `{ id, fileName, url, size, mimeType, uploadedBy, createdAt }`
- **Milestone:** `{ id, projectId, project: {id,name}, name, description, status, startDate, dueDate, completedAt, progress, taskCount }`
- **Client:** `{ id, name, contactName, email, phone, website, industry, notes, status, projectCount, activeProjectCount }` (the detail response adds `projects`, `retainers`)
- **Notification:** `{ id, type, title, body, read, entityType, entityId, actor, createdAt }`
- **Activity:** `{ id, actor, action (display verb), type (machine key), entityType, entityId, entityName, target, message, createdAt }`
- **DailyTask:** `{ id, date, task: TaskSummary, assignee, priority, estimatedHours, dueTime, note }`
- **WorkloadEntry:** `{ userId, name, avatarUrl, departmentName, assigned, estimatedHours, completed, inReview, blocked, overdue }`. This is factual counts only; there is no performance score.

**Analytics payloads.** These match the frontend normalizers in `analytics.ts`.

- **Company:** `{ summary: {activeProjects, completedProjects, atRiskProjects, overdueTasks, completedTasks, inReviewTasks, blockedTasks, openTasks}, projectStatus: [{status,count}], taskStatus: [{status,count}], departmentWorkload: [{departmentId, departmentName, assigned, completed, overdue, estimatedHours}], weeklyActivity: [{date, created, completed}], projectProgress: [{projectId, name, progress, status}], upcomingDeadlines: [{id, kind, title, dueDate, projectId, projectName, assignee, status}], projectsRequiringAttention: [{project, reasons[]}], recentActivity: Activity[], reviewCycle: [{date, averageHours, reviews}] }`
- **Project:** `{ progress, totalTasks, completedTasks, overdueTasks, blockedTasks, inReviewTasks, milestones: {total, completed}, taskStatus, hoursByMember: [{userId, name, estimatedHours, actualHours}], estimatedHours, actualHours, workload: WorkloadEntry[], activity: [{date, created, completed}] }`
- **Department:** `{ departmentName, metrics: [{key, label, value}], taskStatus, workload, activity, breakdowns: [{key, label, items: [{key, count}]}] }`. The metrics depend on the department kind, which is inferred from its name: development, design, marketing, QA or general.
- **Tasks:** `{ taskStatus, byPriority, byType, completion, overdueTrend: [{date, count}], blockedTrend: [{date, count}], reviewCycle }`

---

## 6. Endpoints

Every route requires authentication unless it is marked *public*. Permission names are from §2.

**Auth**

| Method & path | Auth / permission | Request | Response |
|---|---|---|---|
| POST /api/auth/login | public, rate-limited | `{email, password}` | `{user, accessToken}` + cookie |
| POST /api/auth/refresh | refresh cookie | — | `{accessToken}` + rotated cookie |
| POST /api/auth/logout | refresh cookie (optional) | — | 204, clears cookie |
| GET /api/auth/me | ✓ | — | User (with permissions) |
| POST /api/auth/forgot-password | public, rate-limited | `{email}` | 200 always (no account enumeration) |
| POST /api/auth/reset-password | public | `{token, password}` | 200 |
| POST /api/auth/change-password | ✓ | `{currentPassword, newPassword}` | 200 |

**Users**

| Method & path | Auth / permission | Request | Response |
|---|---|---|---|
| GET /api/users | ✓ | `search, role, departmentId, status, page, pageSize ≤200` | paginated User |
| POST /api/users | users:manage | `{name, email, role, departmentId, jobTitle?, password?}` (no password → invite email) | 201 User |
| GET /api/users/:id | ✓ | — | User |
| PATCH /api/users/:id | self (profile fields) or users:manage | `{name?, jobTitle?, phone?, profileImage?, role?, departmentId?, status?, email?}` | User |
| GET /api/users/:id/workload | self, or teams:read / analytics:read | — | WorkloadEntry |

**Departments**

| Method & path | Auth / permission | Request | Response |
|---|---|---|---|
| GET /api/departments | ✓ | — | Department[] |
| POST /api/departments | departments:manage | `{name, description?, headId?}` | 201 |
| GET /api/departments/:id | ✓ | — | Department + members |
| PATCH /api/departments/:id | departments:manage | partial | Department |
| DELETE /api/departments/:id | departments:manage | — | 204, or 409 if it still has members |

**Teams** (backend addition, not used by the UI yet)

| Method & path | Auth / permission | Request | Response |
|---|---|---|---|
| GET /api/teams | teams:read | `departmentId, search, page` | paginated |
| POST /api/teams | teams:manage | `{name, description?, departmentId, leadId?, memberIds[]}` | 201 |
| GET /api/teams/:id | teams:read | — | — |
| PATCH /api/teams/:id | teams:manage | — | — |
| DELETE /api/teams/:id | teams:manage | — | — |

**Projects**

| Method & path | Auth / permission | Request | Response |
|---|---|---|---|
| GET /api/projects | ✓ (scoped) | `search, status, clientId, managerId, memberId, departmentId, sortBy (name\|deadline\|progress\|createdAt), sortOrder, page, pageSize ≤200` | paginated Project |
| POST /api/projects | projects:create | ProjectInput `{name, description, clientId, type, status, priority, startDate, deadline, managerId, memberIds, estimatedHours, departmentId?}` | 201 |
| GET /api/projects/:id | project access | — | Project |
| PATCH /api/projects/:id | projects:update + manage scope | partial | Project |
| DELETE /api/projects/:id | projects:delete | — | 204, or 409 if it has tasks |
| GET /api/projects/:id/members | project access | — | UserSummary[] |
| POST /api/projects/:id/members | manage scope | `{userId}` | 201 |
| DELETE /api/projects/:id/members/:userId | manage scope | — | 204 |
| GET /api/projects/:id/files | project access | — | Attachment[] |
| POST /api/projects/:id/files | project access | multipart `file` | 201 Attachment |

**Tasks**

| Method & path | Auth / permission | Request | Response |
|---|---|---|---|
| GET /api/tasks | ✓ (scoped) | `projectId, milestoneId, parentId, assigneeId(\|me), reviewerId(\|me), departmentId, status (repeatable), priority, overdue, dueFrom, dueTo, search, sortBy (title\|dueDate\|priority\|status\|estimatedHours\|actualHours\|createdAt), sortOrder, page, pageSize ≤500` | paginated TaskSummary |
| GET /api/tasks/my-day | ✓ | `date` | `{date, today, overdue, upcoming, inReview, blocked}` |
| POST /api/tasks | tasks:create + project access | TaskInput (+ `parentId`) | 201 Task |
| GET /api/tasks/:id | task access | — | Task |
| PATCH /api/tasks/:id | tasks:assign, or the assignee (`actualHours` only) | partial | Task |
| DELETE /api/tasks/:id | tasks:delete + manage scope | — | 204 |
| PATCH /api/tasks/:id/status | see §2 | `{status}` | Task |
| POST /api/tasks/:id/submit | assignee or tasks:assign | `{note?}` | Task |
| POST /api/tasks/:id/approve | reviewer / tasks:review | `{feedback?}` | Task |
| POST /api/tasks/:id/request-changes | reviewer / tasks:review | `{feedback}` (≥5 chars) | Task |
| GET /api/tasks/:id/reviews | task access | — | ReviewEntry[] |
| GET /api/tasks/:id/comments | task access | — | Comment[] |
| POST /api/tasks/:id/comments | task access | `{body, mentionIds[]}` | 201 Comment |
| PATCH /api/tasks/:id/comments/:commentId | author | `{body, mentionIds[]}` | Comment |
| DELETE /api/tasks/:id/comments/:commentId | author or tasks:assign | — | 204 |
| POST /api/tasks/:id/attachments | task access | multipart `file` | 201 Attachment |
| DELETE /api/tasks/:id/attachments/:attachmentId | uploader or tasks:assign | — | 204 |

**Files**

| Method & path | Auth / permission | Request | Response |
|---|---|---|---|
| GET /api/files/:id | access to the owning entity | — | Attachment |
| DELETE /api/files/:id | uploader or manage scope | — | 204 |

**Milestones**

| Method & path | Auth / permission | Request | Response |
|---|---|---|---|
| GET /api/milestones | ✓ (scoped) | `projectId, from, to` | Milestone[] |
| POST /api/milestones | projects:update + manage scope | `{projectId, name, description?, startDate?, dueDate?, status?}` | 201 |
| PATCH /api/milestones/:id | manage scope | partial | Milestone |
| DELETE /api/milestones/:id | manage scope | — | 204 (tasks are unlinked) |

**Daily tasks**

| Method & path | Auth / permission | Request | Response |
|---|---|---|---|
| GET /api/daily-tasks | daily_tasks:manage, or own `assigneeId` | `date, assigneeId` | DailyTask[] |
| GET /api/daily-tasks/workload | daily_tasks:manage | `date` | WorkloadEntry[] |
| POST /api/daily-tasks | daily_tasks:manage | `{date, assigneeId, taskId, priority, estimatedHours?, dueTime?, note?}` | 201 |
| DELETE /api/daily-tasks/:id | daily_tasks:manage | — | 204 |

**Notifications**

| Method & path | Auth / permission | Request | Response |
|---|---|---|---|
| GET /api/notifications | ✓ (own) | `page, pageSize, unreadOnly` | paginated |
| GET /api/notifications/unread-count | ✓ | — | `{count}` |
| PATCH /api/notifications/read-all | ✓ | — | 204 |
| PATCH /api/notifications/:id/read | own | — | 204 |
| DELETE /api/notifications/:id | own | — | 204 |

**Activity, clients, search, analytics, settings**

| Method & path | Auth / permission | Request | Response |
|---|---|---|---|
| GET /api/activity | ✓ (scoped) | `entityType, entityId, projectId, userId, departmentId, clientId, page, limit ≤100` | Activity[] |
| GET /api/clients | clients:read | `search, status, page, pageSize` | paginated |
| POST /api/clients | clients:manage | ClientInput | 201 |
| GET /api/clients/:id | clients:read | — | Client + projects + retainers |
| PATCH /api/clients/:id | clients:manage | partial | Client |
| DELETE /api/clients/:id | clients:manage | — | 204, or 409 if it has projects |
| GET /api/search | ✓ (scoped) | `q` (≥2 chars) | `{projects, tasks, people, clients}` (5 each) |
| GET /api/analytics/company | analytics:company | `from, to` | Company analytics |
| GET /api/analytics/projects/:id | project access | — | Project analytics |
| GET /api/analytics/departments/:id | analytics:read or teams:read (dept heads: own department unless analytics:company) | `from, to` | Department analytics |
| GET /api/analytics/tasks | analytics:read (scoped to accessible projects) | `from, to` | Task analytics |
| GET /api/analytics/workload | analytics:read or teams:read | `departmentId, projectId, managerId` | WorkloadEntry[] |
| GET /api/settings/company | ✓ | — | `{name, timezone, workingHoursPerDay, weekStartsOn}` |
| PATCH /api/settings/company | settings:company | partial | settings |
| GET /api/settings/notifications | ✓ (own) | — | `{email, inApp}` |
| PUT /api/settings/notifications | ✓ (own) | `{email, inApp}` | prefs |
| GET /api/health | public | — | `{status, db}` |

---

## 7. Side effects

**Notifications.** Users can switch off in-app notifications per type; those preferences are respected. The triggers are:
- **TASK_ASSIGNED:** a task is created with an assignee, the assignee changes, or a task is added to someone's daily plan.
- **REVIEW_REQUESTED:** a task is submitted; the reviewer is notified, or the project manager if the task has no reviewer.
- **TASK_APPROVED / CHANGES_REQUESTED:** a review decision is made; the assignee is notified.
- **MENTION:** a comment mentions someone.
- **PROJECT_UPDATE:** someone is added to a project, or the project's status changes; members are notified.
- **DEADLINE_APPROACHING:** an optional hourly job (`ENABLE_JOBS=true`) notifies the assignee once per task per day when an open task is due within 24 hours.

**Activity log.** Entries are written for:
- logging in and out
- project created and updated
- members added and removed
- task created, assigned and deleted
- status changes, submissions, approvals and change requests
- comments
- client created
- milestone created and completed

**Project counters.** `taskCount`, `completedTaskCount` and `progress` are recalculated whenever a task is created, deleted, changes status or moves between projects.

---

## 8. File storage

Uploads arrive as multipart `file` fields. Multer keeps them in memory, with a 25 MB limit and a MIME allow-list. They are then passed to a `StorageProvider` interface.

The built-in provider is **S3-compatible**: AWS S3, Cloudflare R2, Supabase Storage (S3 API), MinIO and similar. It is configured with the `STORAGE_*` variables.

If storage is not configured, uploads return **503** "File storage is not configured". Nothing is ever written to the server's local disk.
