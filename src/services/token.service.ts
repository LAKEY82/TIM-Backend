import { createHash, randomBytes, randomUUID } from "node:crypto";
import jwt, { type SignOptions } from "jsonwebtoken";
import { env } from "../config/env";
import type { Role } from "../types/domain";
import { unauthorized } from "../utils/errors";

const ISSUER = "tim-api";
const AUDIENCE = "tim-web";

export interface AccessClaims {
  sub: string;
  sid: string;
  role: Role;
  iat: number;
}

export interface RefreshClaims {
  sub: string;
  sid: string;
  jti: string;
}

export function signAccessToken(userId: string, sessionId: string, role: Role): string {
  return jwt.sign({ sid: sessionId, role }, env.JWT_ACCESS_SECRET, {
    subject: userId,
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithm: "HS256",
    expiresIn: env.ACCESS_TOKEN_TTL as SignOptions["expiresIn"],
  });
}

export function verifyAccessToken(token: string): AccessClaims {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"] });
    if (typeof payload === "string" || !payload.sub || typeof payload.sid !== "string") throw new Error("bad claims");
    return { sub: payload.sub, sid: payload.sid, role: payload.role as Role, iat: payload.iat ?? 0 };
  } catch {
    throw unauthorized("Your session has expired. Please sign in again.");
  }
}

export function signRefreshToken(userId: string, sessionId: string, jti: string): string {
  return jwt.sign({ sid: sessionId, jti }, env.JWT_REFRESH_SECRET, {
    subject: userId,
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithm: "HS256",
    expiresIn: `${env.REFRESH_TOKEN_TTL_DAYS}d` as SignOptions["expiresIn"],
  });
}

export function verifyRefreshToken(token: string): RefreshClaims {
  try {
    const payload = jwt.verify(token, env.JWT_REFRESH_SECRET, { issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"] });
    if (typeof payload === "string" || !payload.sub || typeof payload.sid !== "string" || typeof payload.jti !== "string") {
      throw new Error("bad claims");
    }
    return { sub: payload.sub, sid: payload.sid, jti: payload.jti };
  } catch {
    throw unauthorized("Your session has expired. Please sign in again.");
  }
}

export const newJti = () => randomUUID();
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
/** URL-safe random token for password reset / invite links. */
export const randomToken = () => randomBytes(32).toString("base64url");

/**
 * Session id from a refresh token WITHOUT verifying it. Only for rate-limit
 * bucketing; the token is still fully verified by the handler.
 */
export function peekSessionId(token: string): string | null {
  const payload = jwt.decode(token);
  return payload && typeof payload === "object" && typeof payload.sid === "string" ? payload.sid.slice(0, 64) : null;
}
