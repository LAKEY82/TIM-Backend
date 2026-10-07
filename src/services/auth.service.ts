import bcrypt from "bcryptjs";
import type { Types } from "mongoose";
import { env } from "../config/env";
import { PasswordReset, Session, User } from "../models";
import { unauthorized, unprocessable } from "../utils/errors";
import { logger } from "../utils/logger";
import { logActivity } from "./activity.service";
import { resetLink, sendMail } from "./mail.service";
import { newJti, randomToken, sha256, signAccessToken, signRefreshToken, verifyRefreshToken } from "./token.service";

export const hashPassword = (password: string) => bcrypt.hash(password, env.BCRYPT_ROUNDS);

// A real bcrypt hash of a random string, compared against when the email is
// unknown so login timing does not reveal which accounts exist.
const DUMMY_HASH = bcrypt.hashSync(randomToken(), 10);

interface ClientInfo {
  userAgent?: string | null;
  ip?: string | null;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

const refreshExpiry = () => new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 864e5);

async function issueForNewSession(userId: Types.ObjectId, role: Parameters<typeof signAccessToken>[2], client: ClientInfo): Promise<IssuedTokens> {
  const jti = newJti();
  const expiresAt = refreshExpiry();
  const session = await Session.create({
    user: userId,
    jtiHash: sha256(jti),
    userAgent: client.userAgent?.slice(0, 300) ?? null,
    ip: client.ip ?? null,
    expiresAt,
    lastUsedAt: new Date(),
  });
  const sid = session._id.toHexString();
  return {
    accessToken: signAccessToken(userId.toHexString(), sid, role),
    refreshToken: signRefreshToken(userId.toHexString(), sid, jti),
    refreshExpiresAt: expiresAt,
  };
}

export async function login(email: string, password: string, client: ClientInfo) {
  const user = await User.findOne({ email: email.trim().toLowerCase() }).select("+passwordHash");
  const valid = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  // Same message for unknown email, wrong password and disabled accounts.
  if (!user || !valid) throw unauthorized("Incorrect email or password.");
  if (user.status !== "ACTIVE") throw unauthorized("This account is not active. Contact an administrator.");

  user.lastLoginAt = new Date();
  await user.save();
  const tokens = await issueForNewSession(user._id, user.role, client);
  void logActivity({
    actor: user._id,
    type: "USER_LOGIN",
    verb: "signed in",
    entityType: "USER",
    entityId: user._id,
    message: "signed in",
    department: user.department ?? null,
  });
  return { user, tokens };
}

/**
 * Rotates the refresh token. Presenting an already-rotated token (a replay,
 * e.g. a stolen cookie) revokes the whole session.
 */
export async function refresh(refreshToken: string | undefined): Promise<IssuedTokens> {
  if (!refreshToken) throw unauthorized("No active session.");
  const claims = verifyRefreshToken(refreshToken);
  const session = await Session.findOne({ _id: claims.sid, user: claims.sub });
  if (!session || session.revokedAt || session.expiresAt <= new Date()) throw unauthorized("Your session has ended. Please sign in again.");

  if (session.jtiHash !== sha256(claims.jti)) {
    session.revokedAt = new Date();
    await session.save();
    logger.warn("Refresh token reuse detected; session revoked", { sessionId: session.id });
    throw unauthorized("Your session has ended. Please sign in again.");
  }

  const user = await User.findById(claims.sub).select("role status").lean();
  if (!user || user.status !== "ACTIVE") {
    session.revokedAt = new Date();
    await session.save();
    throw unauthorized("This account is not active.");
  }

  const jti = newJti();
  session.jtiHash = sha256(jti);
  session.expiresAt = refreshExpiry();
  session.lastUsedAt = new Date();
  await session.save();
  return {
    accessToken: signAccessToken(claims.sub, session.id, user.role),
    refreshToken: signRefreshToken(claims.sub, session.id, jti),
    refreshExpiresAt: session.expiresAt,
  };
}

/** Revokes the session behind a refresh token (best effort: bad tokens are ignored). */
export async function logout(refreshToken: string | undefined): Promise<void> {
  if (!refreshToken) return;
  try {
    const claims = verifyRefreshToken(refreshToken);
    const session = await Session.findOneAndUpdate({ _id: claims.sid, user: claims.sub, revokedAt: null }, { revokedAt: new Date() });
    if (session) {
      void logActivity({ actor: session.user, type: "USER_LOGOUT", verb: "signed out", entityType: "USER", entityId: session.user, message: "signed out" });
    }
  } catch {
    // Expired or forged token: nothing to revoke.
  }
}

export async function revokeAllSessions(userId: Types.ObjectId | string, exceptSessionId?: string) {
  await Session.updateMany(
    { user: userId, revokedAt: null, ...(exceptSessionId ? { _id: { $ne: exceptSessionId } } : {}) },
    { revokedAt: new Date() },
  );
}

/** Creates a single-use token and emails a link. Used by forgot-password and invites. */
export async function sendPasswordLink(user: { _id: Types.ObjectId; email: string; firstName: string }, kind: "reset" | "invite") {
  const token = randomToken();
  const ttlMs = kind === "invite" ? 7 * 864e5 : 60 * 60 * 1000;
  await PasswordReset.create({ user: user._id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs) });
  const link = resetLink(token);
  await sendMail(
    kind === "invite"
      ? {
          to: user.email,
          subject: "You've been invited to TIM",
          text: `Hi ${user.firstName},\n\nAn account was created for you. Set your password here (valid for 7 days):\n${link}\n`,
        }
      : {
          to: user.email,
          subject: "Reset your TIM password",
          text: `Hi ${user.firstName},\n\nUse this link to reset your password (valid for 1 hour):\n${link}\n\nIf you didn't ask for this, you can ignore this email.\n`,
        },
  );
}

/** Always succeeds from the caller's point of view, so accounts can't be enumerated. */
export async function forgotPassword(email: string): Promise<void> {
  const user = await User.findOne({ email: email.trim().toLowerCase(), status: "ACTIVE" }).select("email firstName").lean();
  if (user) await sendPasswordLink(user, "reset");
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const record = await PasswordReset.findOne({ tokenHash: sha256(token), usedAt: null, expiresAt: { $gt: new Date() } });
  if (!record) throw unprocessable("This reset link is invalid or has expired.", [{ path: "token", message: "Invalid or expired link." }]);
  const user = await User.findById(record.user);
  if (!user || user.status === "SUSPENDED") throw unprocessable("This reset link is invalid or has expired.");

  user.passwordHash = await hashPassword(newPassword);
  user.passwordChangedAt = new Date();
  await user.save();
  record.usedAt = new Date();
  await record.save();
  // Invalidate other outstanding links and every signed-in device.
  await PasswordReset.updateMany({ user: user._id, usedAt: null }, { usedAt: new Date() });
  await revokeAllSessions(user._id);
}

export async function changePassword(userId: string, sessionId: string, currentPassword: string, newPassword: string) {
  const user = await User.findById(userId).select("+passwordHash");
  if (!user) throw unauthorized();
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    throw unprocessable("Your current password is incorrect.", [{ path: "currentPassword", message: "Incorrect password." }]);
  }
  user.passwordHash = await hashPassword(newPassword);
  user.passwordChangedAt = new Date();
  await user.save();
  // Sign out other devices; this device refreshes into a new access token.
  await revokeAllSessions(user._id, sessionId);
}
