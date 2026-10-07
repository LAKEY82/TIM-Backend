import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Types } from "mongoose";
import { permissionsForRole } from "../config/permissions";
import { Session, User } from "../models";
import { verifyAccessToken } from "../services/token.service";
import type { AuthUser } from "../types/express";
import { unauthorized } from "../utils/errors";

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

/**
 * Verifies the access token, then re-checks the server-side state on every
 * request: the user still exists and is ACTIVE, the session was not revoked,
 * and the password was not changed after the token was issued.
 */
export const requireAuth: RequestHandler = async (req: Request, _res: Response, next: NextFunction) => {
  const token = bearerToken(req);
  if (!token) return next(unauthorized());
  const claims = verifyAccessToken(token);

  if (!Types.ObjectId.isValid(claims.sub) || !Types.ObjectId.isValid(claims.sid)) return next(unauthorized());

  const [user, sessionAlive] = await Promise.all([
    User.findById(claims.sub).select("firstName lastName email role status department passwordChangedAt").lean(),
    Session.exists({ _id: claims.sid, user: claims.sub, revokedAt: null, expiresAt: { $gt: new Date() } }),
  ]);
  if (!user || user.status !== "ACTIVE" || !sessionAlive) return next(unauthorized("Your session has ended. Please sign in again."));
  if (user.passwordChangedAt && claims.iat * 1000 < user.passwordChangedAt.getTime() - 1000) {
    return next(unauthorized("Your password was changed. Please sign in again."));
  }

  const principal: AuthUser = {
    id: user._id.toHexString(),
    _id: user._id,
    role: user.role,
    name: `${user.firstName} ${user.lastName ?? ""}`.trim(),
    email: user.email,
    departmentId: user.department ?? null,
    // Role is read from the database, not from the token, so role changes apply immediately.
    permissions: new Set(permissionsForRole(user.role)),
    sessionId: claims.sid,
  };
  req.user = principal;
  next();
};

/** For handlers mounted behind `requireAuth`. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
