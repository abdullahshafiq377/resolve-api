import ResearchRequest from '../models/ResearchRequest';
import ResearchRequestVote from '../models/ResearchRequestVote';

/**
 * Hard-delete a user's research-request votes and decrement the affected counters,
 * and silently delete their still-pending submissions. Used on ban/freeze + account
 * delete so a removed user leaves no orphan votes (Research Requests data-model
 * contract).
 */
export async function purgeUserResearchData(clerkUserId: string): Promise<void> {
  const votes = await ResearchRequestVote.find({ userId: clerkUserId }).select('requestId');
  const requestIds = [...new Set(votes.map((v) => String(v.requestId)))];

  await ResearchRequestVote.deleteMany({ userId: clerkUserId });
  for (const requestId of requestIds) {
    await ResearchRequest.updateOne({ _id: requestId }, { $inc: { voteCount: -1 } });
  }
  // Clamp any counter that may have gone negative due to races.
  await ResearchRequest.updateMany({ voteCount: { $lt: 0 } }, { $set: { voteCount: 0 } });

  // Their never-approved submissions are removed silently.
  await ResearchRequest.deleteMany({ submitterId: clerkUserId, approvedAt: null });
}
