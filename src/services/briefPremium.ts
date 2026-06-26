import { clerk } from '../config/clerk';
import User from '../models/User';

const SUPER_ADMIN_USER_ID = process.env.SUPER_ADMIN_USER_ID;

// The personalised Resolve Brief is a Standard-tier feature (and above). Any of
// these active subscription slugs grant it. `premium_plan` is the legacy 2-plan
// slug, kept so existing subscribers stay eligible until Clerk migrates them.
export const BRIEF_PLAN_SLUGS = ['standard', 'premium', 'premium_plan'];

export interface BriefEligibility {
  eligible: boolean;
  reason: 'active_paid' | 'moderator' | 'super_admin' | 'not_paid' | 'clerk_error';
}

export async function getBriefEligibility(clerkUserId: string): Promise<BriefEligibility> {
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
      (item) =>
        item.status === 'active' && !!item.plan?.slug && BRIEF_PLAN_SLUGS.includes(item.plan.slug),
    );
    return active
      ? { eligible: true, reason: 'active_paid' }
      : { eligible: false, reason: 'not_paid' };
  } catch (err) {
    console.warn('[resolve-brief] Clerk billing eligibility check failed', {
      clerkUserId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { eligible: false, reason: 'clerk_error' };
  }
}
