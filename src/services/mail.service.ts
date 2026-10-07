import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env";
import { logger } from "../utils/logger";

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!env.smtpConfigured) return null;
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT ?? 587,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
  });
  return transporter;
}

interface Mail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Sends email through SMTP when configured. Without SMTP, development logs the
 * message (so reset links can be used locally); production logs only that a
 * mail could not be sent, never its contents (they contain secret links).
 */
export async function sendMail(mail: Mail): Promise<boolean> {
  const t = getTransporter();
  if (!t) {
    if (env.isProduction) logger.warn("SMTP is not configured; email not sent", { subject: mail.subject });
    else logger.info("Email (SMTP not configured, logged instead)", { to: mail.to, subject: mail.subject, text: mail.text });
    return false;
  }
  try {
    await t.sendMail({ from: env.MAIL_FROM, ...mail });
    return true;
  } catch (error) {
    logger.error("Failed to send email", { subject: mail.subject, message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

export const resetLink = (token: string) => `${env.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
