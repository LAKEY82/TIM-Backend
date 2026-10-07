export interface FieldError {
  path: string;
  message: string;
}

/** An error that is safe to show to the client as-is. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly errors: FieldError[] = [],
    public readonly code?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message = "The request was invalid.", errors: FieldError[] = []) => new AppError(400, message, errors);
export const unauthorized = (message = "Authentication required.") => new AppError(401, message, [], "UNAUTHORIZED");
export const forbidden = (message = "You don't have permission to do that.") => new AppError(403, message, [], "FORBIDDEN");
export const notFound = (what = "Resource") => new AppError(404, `${what} not found.`, [], "NOT_FOUND");
export const conflict = (message: string, errors: FieldError[] = []) => new AppError(409, message, errors, "CONFLICT");
export const unprocessable = (message: string, errors: FieldError[] = []) => new AppError(422, message, errors, "VALIDATION_FAILED");
export const serviceUnavailable = (message: string) => new AppError(503, message, [], "SERVICE_UNAVAILABLE");
