import mongoose, { Schema, Document, Model } from 'mongoose';

export const CONTACT_TOPICS = ['story_tip', 'membership', 'partnership', 'other'] as const;

export type ContactTopic = (typeof CONTACT_TOPICS)[number];

export interface ContactMessageDoc extends Document {
  name: string;
  email: string;
  topic: ContactTopic;
  topicDetail?: string;
  message: string;
  createdAt: Date;
  updatedAt: Date;
}

const ContactMessageSchema = new Schema<ContactMessageDoc>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    topic: { type: String, required: true, enum: CONTACT_TOPICS, index: true },
    topicDetail: { type: String, trim: true, maxlength: 160 },
    message: { type: String, required: true, trim: true, maxlength: 4000 },
  },
  { timestamps: true },
);

ContactMessageSchema.index({ createdAt: -1 });

const ContactMessage: Model<ContactMessageDoc> =
  mongoose.models.ContactMessage ||
  mongoose.model<ContactMessageDoc>('ContactMessage', ContactMessageSchema);

export default ContactMessage;
