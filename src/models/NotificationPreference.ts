import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * Per-user switches for what Resolve notifies about, backing the account
 * management "Notifications" section.
 *
 * A row is created lazily on first read or write; a user without one is treated
 * as having every switch on, which is the product default (see DEFAULTS below).
 *
 * `briefReady` is about the in-app/push "your brief is ready" ping only. Whether
 * the brief is *emailed* stays on BriefPreference.emailEnabled, owned by the
 * brief preferences section — the two are deliberately separate controls.
 */
export interface NotificationPreferenceDoc extends Document {
  clerkUserId: string;
  briefReady: boolean;
  researchUpdates: boolean;
  commentReplies: boolean;
  weeklyNewsletter: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const NotificationPreferenceSchema = new Schema<NotificationPreferenceDoc>(
  {
    clerkUserId: { type: String, required: true, trim: true },
    briefReady: { type: Boolean, default: true },
    researchUpdates: { type: Boolean, default: true },
    commentReplies: { type: Boolean, default: true },
    weeklyNewsletter: { type: Boolean, default: true },
  },
  { timestamps: true },
);

NotificationPreferenceSchema.index({ clerkUserId: 1 }, { unique: true });

const NotificationPreference: Model<NotificationPreferenceDoc> =
  mongoose.models.NotificationPreference ||
  mongoose.model<NotificationPreferenceDoc>(
    'NotificationPreference',
    NotificationPreferenceSchema,
  );

export default NotificationPreference;
