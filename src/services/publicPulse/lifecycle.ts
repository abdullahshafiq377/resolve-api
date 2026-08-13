import Poll from '../../models/Poll';
import { recordActivity } from '../activity';

export async function runPublicPulseTransitions(now = new Date()) {
  const opened: string[] = [];
  const closed: string[] = [];

  const scheduled = await Poll.find({ status: 'scheduled', opensAt: { $lte: now } });
  for (const poll of scheduled) {
    const updated = await Poll.findOneAndUpdate(
      { _id: poll._id, status: 'scheduled', opensAt: { $lte: now } },
      {
        $set: {
          status: 'open',
          opensAt: null,
          publishedBy: 'system',
          publishedAt: now,
          lastEditedBy: 'system',
          lastSystemTransitionAt: now,
        },
      },
      { new: true },
    );
    if (!updated) continue;
    // No actor — the cron opened it, so the timeline reads "System".
    await recordActivity({
      entityType: 'poll',
      entityId: updated._id as typeof poll._id,
      action: 'auto_published',
      metadata: { from: 'scheduled', to: 'open', opensAt: poll.opensAt?.toISOString() ?? null },
    });
    opened.push(String(updated._id));
  }

  const open = await Poll.find({ status: 'open', closeDate: { $lte: now } });
  for (const poll of open) {
    const updated = await Poll.findOneAndUpdate(
      { _id: poll._id, status: 'open', closeDate: { $lte: now } },
      {
        $set: {
          status: 'closed',
          featured: false,
          closedBy: 'system',
          closedAt: now,
          lastEditedBy: 'system',
          lastSystemTransitionAt: now,
        },
      },
      { new: true },
    );
    if (!updated) continue;
    await recordActivity({
      entityType: 'poll',
      entityId: updated._id as typeof poll._id,
      action: 'auto_closed',
      metadata: { from: 'open', to: 'closed', closeDate: poll.closeDate.toISOString() },
    });
    closed.push(String(updated._id));
  }

  return { opened, closed };
}
