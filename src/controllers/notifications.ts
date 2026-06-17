import type { Request, Response } from 'express';
import { getAuth } from '@clerk/express';
import Notification from '../models/Notification';
import { parsePagination, buildPagination } from '../services/researchRequests';
import { serializeNotification } from '../lib/serializers/researchRequest';

// GET /api/notifications — inbox for the current user.
export async function listNotifications(req: Request, res: Response) {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>, 30, 100);
  const filter: Record<string, unknown> = { userId };
  if (req.query.unreadOnly === 'true') filter.read = false;

  const [rows, total, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Notification.countDocuments(filter),
    Notification.countDocuments({ userId, read: false }),
  ]);

  res.json({
    data: rows.map(serializeNotification),
    unreadCount,
    pagination: buildPagination(total, page, limit),
  });
}

// POST /api/notifications/mark-read — mark some or all notifications read.
export async function markRead(req: Request, res: Response) {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const { ids, all } = req.body as { ids?: unknown; all?: unknown };
  const filter: Record<string, unknown> = { userId, read: false };

  if (all === true) {
    // mark every unread row
  } else if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) {
    if (ids.length === 0) return res.json({ updated: 0 });
    filter._id = { $in: ids };
  } else {
    return res.status(400).json({ error: 'validation_error' });
  }

  const result = await Notification.updateMany(filter, {
    $set: { read: true, readAt: new Date() },
  });
  res.json({ updated: result.modifiedCount });
}
