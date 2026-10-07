import type { Types } from "mongoose";
import { Activity } from "../models";
import type { EntityType } from "../types/domain";
import { logger } from "../utils/logger";

export interface ActivityInput {
  actor?: Types.ObjectId | null;
  type: string;
  verb: string;
  entityType: EntityType;
  entityId: Types.ObjectId;
  entityName?: string;
  target?: { type: EntityType; id: Types.ObjectId; name: string } | null;
  message?: string | null;
  project?: Types.ObjectId | null;
  department?: Types.ObjectId | null;
  client?: Types.ObjectId | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Appends to the audit log. Logging must never break the user's action, so a
 * failure here is reported but swallowed.
 */
export async function logActivity(input: ActivityInput): Promise<void> {
  try {
    await Activity.create({ entityName: "", ...input });
  } catch (error) {
    logger.error("Failed to write activity", { type: input.type, message: error instanceof Error ? error.message : String(error) });
  }
}
