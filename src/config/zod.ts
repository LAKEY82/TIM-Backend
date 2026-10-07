import { z } from "zod";

/**
 * Friendlier default messages for validation errors that reach the UI.
 * Schema-specific messages still take precedence.
 */
z.config({
  customError: (issue) => {
    if (issue.code === "invalid_type" && issue.input === undefined) return "This field is required.";
    if (issue.code === "invalid_type") return `Expected ${issue.expected}.`;
    return undefined;
  },
});
