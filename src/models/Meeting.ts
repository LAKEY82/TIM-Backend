import { Schema, model, type Types } from "mongoose";
import { MEETING_PLATFORMS, type MeetingPlatform } from "../types/domain";

export interface IMeeting {
  title: string;
  description?: string | null;
  platform: MeetingPlatform;
  /** Join link (Zoom, Google Meet, Teams… or anything else). */
  link?: string | null;
  startAt: Date;
  endAt: Date;
  project?: Types.ObjectId | null;
  organizer: Types.ObjectId;
  /** Invited people (the organizer isn't repeated here). Bounded, queried through a multikey index. */
  participants: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
  expireAt: Date;
}

const meetingSchema = new Schema<IMeeting>(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 5000, default: null },
    platform: { type: String, enum: MEETING_PLATFORMS, default: "OTHER" },
    link: { type: String, trim: true, maxlength: 1000, default: null },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    project: { type: Schema.Types.ObjectId, ref: "Project", default: null },
    organizer: { type: Schema.Types.ObjectId, ref: "User", required: true },
    participants: [{ type: Schema.Types.ObjectId, ref: "User" }],
    // 30 days after the meeting ends. Mongoose calls this with the meeting as `this`.
    expireAt: {
      type: Date,
      default: function (this: IMeeting) {
        return new Date(this.endAt.getTime() + 30 * 24 * 60 * 60 * 1000);
      },
    },
  },
  { timestamps: true },
);

meetingSchema.index({ organizer: 1, startAt: 1 });
meetingSchema.index({ participants: 1, startAt: 1 });
meetingSchema.index({ expireAt: 1 });

export const Meeting = model<IMeeting>("Meeting", meetingSchema);
