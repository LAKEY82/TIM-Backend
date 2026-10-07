import type { NextFunction, Request, Response } from "express";
import { type z, type ZodType } from "zod";
import { AppError, badRequest, type FieldError } from "../utils/errors";

export function zodFieldErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }));
}

function parseWith<S extends ZodType>(schema: S, input: unknown, status: number, message: string): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError(status, message, zodFieldErrors(result.error), "VALIDATION_FAILED");
  return result.data;
}

/**
 * Typed parsers used by route handlers. Body problems are 422 (the frontend
 * maps `errors[].path` onto form fields); query/param problems are 400.
 */
export const parseBody = <S extends ZodType>(schema: S, req: Request): z.output<S> =>
  parseWith(schema, req.body ?? {}, 422, "Please correct the highlighted fields.");

export const parseQuery = <S extends ZodType>(schema: S, req: Request): z.output<S> =>
  parseWith(schema, req.query, 400, "Invalid query parameters.");

/** Express middleware form, for routes that only need the body validated up front. */
export function validateBody(schema: ZodType) {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.body = parseBody(schema, req);
    next();
  };
}

/** Rejects malformed ObjectIds in route params with 400 before any query runs. */
export function validateObjectIds(...names: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    for (const name of names) {
      const value = req.params[name];
      if (value !== undefined && !(typeof value === "string" && /^[a-f\d]{24}$/i.test(value))) {
        return next(badRequest(`Invalid ${name}.`, [{ path: name, message: "Must be a valid id." }]));
      }
    }
    next();
  };
}

/** A route param as a string (params are validated by `validateObjectIds` via `router.param`). */
export function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? String(value[0]) : String(value ?? "");
}
