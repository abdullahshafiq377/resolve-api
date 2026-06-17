import mongoose, { Schema, Document, Model } from 'mongoose';

export const NOTIFICATION_TYPES = [
  'request_submitted',
  'request_approved',
  'request_rejected',
  'request_under_consideration',
  'request_being_investigated',
  'request_published',
  'request_not_pursued',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

// High-signal types are deduplicated per (userId, requestId, type) via a partial
// unique index, so re-firing the same event updates the existing row rather than
// creating a duplicate. Low-signal status changes are NOT deduplicated.
export const HIGH_SIGNAL_TYPES: NotificationType[] = [
  'request_published',
  'request_rejected',
  'request_not_pursued',
];

export const EMAIL_STATUSES = ['not_applicable', 'pending', 'sent', 'failed', 'no_email'] as const;

export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export interface NotificationDoc extends Document {
  // Clerk user ID of the recipient.
  userId: string;
  type: NotificationType;
  requestId: mongoose.Types.ObjectId | null;
  title: string;
  body: string;
  // In-app URL the notification navigates to.
  link: string;
  emailStatus: EmailStatus;
  emailSentAt: Date | null;
  emailError: string | null;
  read: boolean;
  readAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const NotificationSchema = new Schema<NotificationDoc>(
  {
    userId: { type: String, required: true, trim: true, index: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    requestId: { type: Schema.Types.ObjectId, ref: 'ResearchRequest', default: null },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    body: { type: String, required: true, trim: true, maxlength: 280 },
    link: { type: String, required: true, trim: true },
    emailStatus: { type: String, enum: EMAIL_STATUSES, default: 'not_applicable' },
    emailSentAt: { type: Date, default: null },
    emailError: { type: String, default: null, maxlength: 500 },
    read: { type: Boolean, default: false },
    readAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Inbox list (newest first).
NotificationSchema.index({ userId: 1, createdAt: -1 });
// Unread badge count + unread list.
NotificationSchema.index({ userId: 1, read: 1, createdAt: -1 });
// Dedup high-signal types: one row per (user, request, high-signal-type).
NotificationSchema.index(
  { userId: 1, requestId: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: {
      type: { $in: HIGH_SIGNAL_TYPES },
    },
  },
);

const Notification: Model<NotificationDoc> =
  mongoose.models.Notification ||
  mongoose.model<NotificationDoc>('Notification', NotificationSchema);

export default Notification;
