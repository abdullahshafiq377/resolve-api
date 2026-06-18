import Poll from '../../models/Poll';

export async function runPublicPulseTransitions(now = new Date()) {
  const opened: string[] = [];
  const closed: string[] = [];

  const scheduled = await Poll.find({ status: 'scheduled', opensAt: { $lte: now } });
  for (const poll of scheduled) {
    const updated = await Poll.findOneAndUpdate(
      { _id: poll._id, status: 'scheduled', opensAt: { $lte: now } },
      {
        $set: {
          status: 'active',
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
    opened.push(String(updated._id));
  }

  const active = await Poll.find({ status: 'active', closeDate: { $lte: now } });
  for (const poll of active) {
    const updated = await Poll.findOneAndUpdate(
      { _id: poll._id, status: 'active', closeDate: { $lte: now } },
      {
        $set: {
          status: 'closed',
          closedBy: 'system',
          closedAt: now,
          lastEditedBy: 'system',
          lastSystemTransitionAt: now,
        },
      },
      { new: true },
    );
    if (!updated) continue;
    closed.push(String(updated._id));
  }

  return { opened, closed };
}
