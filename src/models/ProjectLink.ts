import { Schema, model, type Types } from "mongoose";
import { PROJECT_LINK_KINDS, type ProjectLinkKind } from "../types/domain";

/** A link kept on a project: its Figma designs, GitHub repo, docs and so on. */
export interface IProjectLink {
  project: Types.ObjectId;
  title: string;
  url: string;
  /** Worked out from the URL (figma.com → FIGMA, github.com → GITHUB). */
  kind: ProjectLinkKind;
  addedBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const projectLinkSchema = new Schema<IProjectLink>(
  {
    project: { type: Schema.Types.ObjectId, ref: "Project", required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    url: { type: String, required: true, trim: true, maxlength: 2000 },
    kind: { type: String, enum: PROJECT_LINK_KINDS, default: "OTHER" },
    addedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

projectLinkSchema.index({ project: 1, kind: 1, createdAt: 1 });

export const ProjectLink = model<IProjectLink>("ProjectLink", projectLinkSchema);
