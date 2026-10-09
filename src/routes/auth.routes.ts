import { Router, type CookieOptions, type NextFunction, type Request, type Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { isAllowedOrigin } from "../config/cors";
import { env } from "../config/env";
import { currentUser, requireAuth } from "../middleware/auth.middleware";
import { parseBody } from "../middleware/validation.middleware";
import { User } from "../models";
import * as auth from "../services/auth.service";
import { peekSessionId } from "../services/token.service";
import { isQaTester } from "../services/user.service";
import { forbidden, notFound } from "../utils/errors";
import { noContent, ok } from "../utils/http";
import { serializeUser } from "../utils/serialize";
import { changePasswordSchema, forgotPasswordSchema, loginSchema, resetPasswordSchema } from "../validators/auth.validators";

export const REFRESH_COOKIE = "tim_rt";

function cookieOptions(expires?: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: env.isProduction || env.cookieSameSite === "none",
    sameSite: env.cookieSameSite,
    // Only sent to the auth endpoints that need it.
    path: "/api/auth",
    domain: env.COOKIE_DOMAIN || undefined,
    expires,
  };
}

const setRefreshCookie = (res: Response, token: string, expires: Date) => res.cookie(REFRESH_COOKIE, token, cookieOptions(expires));
const clearRefreshCookie = (res: Response) => res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), expires: undefined });
const readRefreshCookie = (req: Request): string | undefined => {
  const value: unknown = req.cookies?.[REFRESH_COOKIE];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

/**
 * CSRF defence for cookie-authenticated endpoints: a cross-site page can make
 * the browser send the cookie, but it can't fake the Origin header.
 */
function requireTrustedOrigin(req: Request, _res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) return next(forbidden("Request origin not allowed."));
  next();
}

const limiterBase = { standardHeaders: "draft-8" as const, legacyHeaders: false, skip: () => env.isTest };
const message = (msg: string) => ({ success: false, message: msg, errors: [] });

/**
 * Keys include the email (login/forgot) or the session (refresh), not just the
 * IP: a whole office often shares one NAT address, and an IP-only key would
 * let one busy office lock everyone out.
 */
const ipAndEmail = (req: Request) =>
  `${ipKeyGenerator(req.ip ?? "")}:${typeof req.body?.email === "string" ? req.body.email.toLowerCase().slice(0, 254) : ""}`;

/** 10 attempts per 15 minutes per IP + email. */
const loginLimiter = rateLimit({
  ...limiterBase,
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: ipAndEmail,
  message: message("Too many sign-in attempts. Please wait a few minutes and try again."),
});
const passwordLimiter = rateLimit({ ...limiterBase, windowMs: 15 * 60 * 1000, limit: 10, keyGenerator: ipAndEmail, message: message("Too many requests. Please try again later.") });
/** Per session (the stable `sid` inside the rotating refresh token); otherwise per IP. */
const refreshLimiter = rateLimit({
  ...limiterBase,
  windowMs: 15 * 60 * 1000,
  limit: 120,
  keyGenerator: (req) => {
    const token = readRefreshCookie(req);
    const sid = token ? peekSessionId(token) : null;
    return sid ? `sid:${sid}` : `ip:${ipKeyGenerator(req.ip ?? "")}`;
  },
  message: message("Too many requests."),
});

const clientInfo = (req: Request) => ({ userAgent: req.get("user-agent") ?? null, ip: req.ip ?? null });

export const authRouter = Router();

authRouter.post("/login", loginLimiter, async (req, res) => {
  const { email, password } = parseBody(loginSchema, req);
  const { user, tokens } = await auth.login(email, password, clientInfo(req));
  setRefreshCookie(res, tokens.refreshToken, tokens.refreshExpiresAt);
  const full = await User.findById(user._id).populate("department", "name").lean();
  ok(res, { user: { ...serializeUser(full!, { withPermissions: true }), isQaTester: await isQaTester(full!._id) }, accessToken: tokens.accessToken }, "Signed in.");
});

authRouter.post("/refresh", refreshLimiter, requireTrustedOrigin, async (req, res) => {
  try {
    const tokens = await auth.refresh(readRefreshCookie(req));
    setRefreshCookie(res, tokens.refreshToken, tokens.refreshExpiresAt);
    ok(res, { accessToken: tokens.accessToken });
  } catch (error) {
    clearRefreshCookie(res);
    throw error;
  }
});

authRouter.post("/logout", requireTrustedOrigin, async (req, res) => {
  await auth.logout(readRefreshCookie(req));
  clearRefreshCookie(res);
  noContent(res);
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await User.findById(currentUser(req).id).populate("department", "name").lean();
  if (!user) throw notFound("User");
  ok(res, { ...serializeUser(user, { withPermissions: true }), isQaTester: await isQaTester(user._id) });
});

authRouter.post("/forgot-password", passwordLimiter, async (req, res) => {
  const { email } = parseBody(forgotPasswordSchema, req);
  await auth.forgotPassword(email);
  ok(res, null, "If an account exists for that email, a reset link has been sent.");
});

authRouter.post("/reset-password", passwordLimiter, async (req, res) => {
  const { token, password } = parseBody(resetPasswordSchema, req);
  await auth.resetPassword(token, password);
  clearRefreshCookie(res);
  ok(res, null, "Password updated. You can now sign in.");
});

authRouter.post("/change-password", requireAuth, async (req, res) => {
  const user = currentUser(req);
  const { currentPassword, newPassword } = parseBody(changePasswordSchema, req);
  await auth.changePassword(user.id, user.sessionId, currentPassword, newPassword);
  ok(res, null, "Password changed.");
});
