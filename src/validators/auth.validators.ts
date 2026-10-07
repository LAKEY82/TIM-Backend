import { z } from "zod";

export const email = z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address.")).pipe(z.string().max(254));

/** Matches the frontend rule (8+ chars, a letter and a number). bcrypt only uses the first 72 bytes. */
export const password = z
  .string()
  .min(8, "Use at least 8 characters.")
  .refine((v) => /[A-Za-z]/.test(v), "Include at least one letter.")
  .refine((v) => /\d/.test(v), "Include at least one number.")
  .refine((v) => Buffer.byteLength(v, "utf8") <= 72, "Use at most 72 bytes.");

export const loginSchema = z.object({
  email,
  password: z.string().min(1, "Password is required.").max(200),
});

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z.object({
  token: z.string().min(10).max(200),
  password,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password.").max(200),
  newPassword: password,
});
