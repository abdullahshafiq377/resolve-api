import mongoose, { Schema, Document, Model } from 'mongoose';

// Local mirror of Clerk users (§6). Used for relational data (FKs, joins, display
// caching), not for role enforcement. Clerk's plan claim stays the authority on
// tier (BACKEND_BILLING.md) — `planTier` below is a denormalised snapshot of it,
// never a substitute at request time. The only role value ever set is
// 'moderator'; regular users (incl. super admin) carry NULL.
export type UserRole = 'moderator';

/** Mirrors PlanTier in middleware/auth, duplicated to keep the model dependency-free. */
export type UserPlanTier = 'free' | 'standard' | 'premium';

export interface UserDoc extends Document {
  clerkUserId: string;
  email: string | null;
  // Cached from Clerk firstName+lastName / username so list joins avoid Clerk round-trips.
  displayName: string | null;
  imageUrl: string | null;
  role: UserRole | null;
  /**
   * Last tier seen from Clerk Billing. NULL = never resolved. Billing has no bulk
   * endpoint and no subscriber-count call, so aggregate questions ("how many
   * premium subscribers?") are answered from this column instead of one Clerk
   * round-trip per user. Written whenever a tier is resolved for any other reason
   * and swept by the billing-tier-reconcile cron; treat it as possibly stale.
   */
  planTier: UserPlanTier | null;
  planTierCheckedAt: Date | null;
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
      enum: ['moderator'],
      default: null,
    },
    planTier: { type: String, enum: ['free', 'standard', 'premium'], default: null },
    planTierCheckedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Fast lookup of active users by role (e.g. moderator picker), mirroring
// idx_users_role_active in the spec.
UserSchema.index({ role: 1 }, { partialFilterExpression: { deletedAt: null } });

// Serves the premium-subscriber count on the admin overview.
UserSchema.index({ planTier: 1 }, { partialFilterExpression: { deletedAt: null } });
// Serves the reconcile sweep: oldest-checked rows first, nulls included.
UserSchema.index({ planTierCheckedAt: 1 });

const User: Model<UserDoc> =
  mongoose.models.User || mongoose.model<UserDoc>('User', UserSchema);

export default User;
