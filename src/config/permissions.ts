import type { Role } from "../types/domain";

/**
 * Role → permission matrix. The vocabulary is the frontend's
 * (`frontend/src/lib/permissions.ts`), because `GET /api/auth/me` returns this
 * list and the UI gates on it verbatim. Entries marked "backend" are extra
 * capabilities the UI does not check (it just receives 403s otherwise).
 *
 * This file is the single source of truth: the server enforces it on every
 * route, regardless of what the client shows.
 */
export const PERMISSIONS = [
  "dashboard:company",
  "dashboard:operations",
  "dashboard:team",
  "projects:read_all",
  "projects:create",
  "projects:update",
  "projects:delete", // backend
  "tasks:create",
  "tasks:assign",
  "tasks:review",
  "tasks:read_all",
  "tasks:delete", // backend
  "daily_tasks:manage",
  "teams:read",
  "teams:manage", // backend
  "clients:read",
  "clients:manage",
  "analytics:read",
  "analytics:company",
  "users:manage",
  "departments:manage",
  "settings:company",
  "timeline:read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const MANAGEMENT: Permission[] = [
  "dashboard:operations",
  "dashboard:team",
  "projects:read_all",
  "projects:create",
  "projects:update",
  "tasks:create",
  "tasks:assign",
  "tasks:review",
  "tasks:read_all",
  "tasks:delete",
  "daily_tasks:manage",
  "teams:read",
  "teams:manage",
  "clients:read",
  "clients:manage",
  "analytics:read",
  "analytics:company",
  "timeline:read",
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  ADMIN: PERMISSIONS,
  CEO: [...MANAGEMENT, "dashboard:company", "settings:company"],
  MANAGING_DIRECTOR: [...MANAGEMENT, "dashboard:company"],
  PROJECT_MANAGER: [
    "dashboard:team",
    "projects:create",
    "projects:update",
    "tasks:create",
    "tasks:assign",
    "tasks:review",
    "tasks:delete",
    "daily_tasks:manage",
    "teams:read",
    "clients:read",
    "analytics:read",
    "timeline:read",
  ],
  DEPARTMENT_HEAD: [
    "dashboard:team",
    "tasks:create",
    "tasks:assign",
    "tasks:review",
    "daily_tasks:manage",
    "teams:read",
    "analytics:read",
    "timeline:read",
  ],
  EMPLOYEE: ["timeline:read"],
};

export function permissionsForRole(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function roleHas(role: Role, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}
