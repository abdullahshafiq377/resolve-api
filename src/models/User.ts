import mongoose, { Schema, Document, Model } from 'mongoose';

// Local mirror of Clerk users (§6). Used for relational data (FKs, joins, display
// caching), not for role enforcement — backend role checks read super admin from
// env (SUPER_ADMIN_USER_ID) first. A super admin row, if present, holds role 'free_user'.
export type UserRole = 'moderator' | 'premium_user' | 'free_user';

export interface UserDoc extends Document {
  clerkUserId: string;
  email: string | null;
  // Cached from Clerk firstName+lastName / username so list joins avoid Clerk round-trips.
  displayName: string | null;
  imageUrl: string | null;
  role: UserRole | null;
  // Soft delete: null = active. Preserves FK integrity for articles authored by the user.
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<UserDoc>(
  {
    clerkUserId: { type: String, required: true, unique: true, index: true },
    email: { type: String, default: null },
    displayName: { type: String, default: null },
    imageUrl: { type: String, default: null },
    role: {
      type: String,
      enum: ['moderator', 'premium_user', 'free_user'],
      default: null,
    },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Fast lookup of active users by role (e.g. moderator picker), mirroring
// idx_users_role_active in the spec.
UserSchema.index({ role: 1 }, { partialFilterExpression: { deletedAt: null } });

const User: Model<UserDoc> =
  mongoose.models.User || mongoose.model<UserDoc>('User', UserSchema);

export default User;
