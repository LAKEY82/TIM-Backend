import type { NextFunction, Request, Response } from "express";
import type { Permission } from "../config/permissions";
import { accessibleProject, type ProjectAccessLevel } from "../services/access.service";
import type { Role } from "../types/domain";
import { forbidden, unauthorized } from "../utils/errors";

/** Requires every listed permission. */
export function requirePermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!permissions.every((p) => req.user!.permissions.has(p))) return next(forbidden());
    next();
  };
}

/** Requires at least one of the listed permissions. */
export function requireAnyPermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!permissions.some((p) => req.user!.permissions.has(p))) return next(forbidden());
    next();
  };
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

/**
 * Loads the project named by a route param and checks the caller may read or
 * manage it. The loaded (lean) project is stored on `res.locals.project`.
 */
export function requireProjectAccess(level: ProjectAccessLevel = "read", param = "id") {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    res.locals.project = await accessibleProject(req.user, String(req.params[param]), level);
    next();
  };
}
