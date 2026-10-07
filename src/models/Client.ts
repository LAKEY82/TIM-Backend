import { Schema, model, type Types } from "mongoose";
import { CLIENT_STATUSES, type ClientStatus } from "../types/domain";

export interface IRetainer {
  _id: Types.ObjectId;
  name: string;
  status: string;
  startDate?: Date | null;
  endDate?: Date | null;
  hoursPerMonth?: number | null;
}

export interface IClient {
  name: string;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  industry?: string | null;
  notes?: string | null;
  status: ClientStatus;
  /** Few per client and always read together with it, so embedded. */
  retainers: IRetainer[];
  createdAt: Date;
  updatedAt: Date;
}

const retainerSchema = new Schema<IRetainer>({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  status: { type: String, default: "ACTIVE", maxlength: 40 },
  startDate: { type: Date, default: null },
  endDate: { type: Date, default: null },
  hoursPerMonth: { type: Number, min: 0, default: null },
});

const clientSchema = new Schema<IClient>(
  {
    name: { type: String, required: true, trim: true, maxlength: 150 },
    contactName: { type: String, trim: true, maxlength: 150, default: null },
    email: { type: String, trim: true, lowercase: true, maxlength: 254, default: null },
    phone: { type: String, trim: true, maxlength: 40, default: null },
    website: { type: String, trim: true, maxlength: 300, default: null },
    industry: { type: String, trim: true, maxlength: 100, default: null },
    notes: { type: String, trim: true, maxlength: 5000, default: null },
    status: { type: String, enum: CLIENT_STATUSES, default: "ACTIVE" },
    retainers: { type: [retainerSchema], default: [] },
  },
  { timestamps: true },
);

clientSchema.index({ name: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });

export const Client = model<IClient>("Client", clientSchema);
