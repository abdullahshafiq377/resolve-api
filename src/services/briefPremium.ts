import { clerk } from '../config/clerk';
import User from '../models/User';

const SUPER_ADMIN_USER_ID = process.env.SUPER_ADMIN_USER_ID;
export const PREMIUM_PLAN_SLUG = 'premium_plan';

export interface BriefEligibility {
  eligible: boolean;
  reason: 'active_premium' | 'moderator' | 'super_admin' | 'not_premium' | 'clerk_error';
}

export async function getBriefPremiumEligibility(clerkUserId: string): Promise<BriefEligibility> {
  if (SUPER_ADMIN_USER_ID && clerkUserId === SUPER_ADMIN_USER_ID) {
    return { eligible: true, reason: 'super_admin' };
  }

  const user = await User.findOne({ clerkUserId, deletedAt: null }).select('role');
  if (user?.role === 'moderator') {
    return { eligible: true, reason: 'moderator' };
  }

  try {
    const subscription = await clerk.billing.getUserBillingSubscription(clerkUserId);
    const items = subscription?.subscriptionItems ?? [];
    const active = items.some(
      (item) => item.status === 'active' && item.plan?.slug === PREMIUM_PLAN_SLUG,
    );
    return active
      ? { eligible: true, reason: 'active_premium' }
      : { eligible: false, reason: 'not_premium' };
  } catch (err) {
    console.warn('[resolve-brief] Clerk billing eligibility check failed', {
      clerkUserId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { eligible: false, reason: 'clerk_error' };
  }
}
