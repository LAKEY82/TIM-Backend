import { isValidObjectId } from "mongoose";
import { z } from "zod";
import { PRIORITIES } from "../types/domain";

/** A 24-hex ObjectId string. */
export const objectId = z.string().trim().refine((v) => isValidObjectId(v) && /^[a-f\d]{24}$/i.test(v), "Must be a valid id.");
export const nullableObjectId = objectId.nullable().optional();

/** `yyyy-MM-dd` or a full ISO timestamp → Date. Empty string → null. */
export const dateInput = z
  .union([z.string().trim(), z.null()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00.000Z` : v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: "custom", message: "Use a valid date." });
      return z.NEVER;
    }
    return d;
  });

export const dayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the yyyy-MM-dd format.");

export const optionalText = (max: number) =>
  z
    .union([z.string().trim().max(max), z.null()])
    .optional()
    .transform((v) => (v === "" ? null : v));

export const priority = z.enum(PRIORITIES);

export const hours = (max: number) => z.number().min(0).max(max).nullable().optional();

/** Query booleans arrive as strings. */
export const queryBool = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === "true" || v === "1"));

/**
 * Pagination accepts `pageSize` (what the frontend sends) or `limit`.
 * `max` is per route: lists the UI renders whole (boards, pickers) allow more.
 */
export function paginationQuery(max = 100, defaultSize = 20) {
  return z
    .object({
      page: z.coerce.number().int().min(1).max(100_000).default(1),
      pageSize: z.coerce.number().int().min(1).max(max).optional(),
      limit: z.coerce.number().int().min(1).max(max).optional(),
    })
    .transform(({ page, pageSize, limit }) => {
      const size = pageSize ?? limit ?? defaultSize;
      return { page, pageSize: size, skip: (page - 1) * size };
    });
}

export const sortOrder = z.enum(["asc", "desc"]).default("asc");

/** Escapes user text for safe use inside a RegExp (search). */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function searchRegex(value: string | undefined): RegExp | undefined {
  const v = value?.trim();
  return v ? new RegExp(escapeRegex(v.slice(0, 100)), "i") : undefined;
}

/** Query param that may appear once or repeated (`?status=A&status=B`). */
export function oneOrMany<T extends z.ZodType>(item: T) {
  return z
    .union([item, z.array(item)])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]));
}
