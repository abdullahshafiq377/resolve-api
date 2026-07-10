import type { Request, Response } from 'express';
import ContactMessage, {
  CONTACT_TOPICS,
  type ContactMessageDoc,
  type ContactTopic,
} from '../models/ContactMessage';
import { httpError } from '../utils/errors';

const TOPIC_LABELS: Record<ContactTopic, string> = {
  story_tip: 'Story Tip',
  membership: 'Membership',
  partnership: 'Partnership',
  other: 'Other',
};

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isTopic(value: unknown): value is ContactTopic {
  return typeof value === 'string' && CONTACT_TOPICS.includes(value as ContactTopic);
}

function parsePositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function serializeContactMessage(message: ContactMessageDoc) {
  return {
    _id: String(message._id),
    id: String(message._id),
    name: message.name,
    email: message.email,
    topic: message.topic,
    topicLabel: TOPIC_LABELS[message.topic],
    topicDetail: message.topicDetail ?? '',
    message: message.message,
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
  };
}

export async function createContactMessage(req: Request, res: Response) {
  const name = cleanString(req.body.name);
  const email = cleanString(req.body.email).toLowerCase();
  const topic = req.body.topic;
  const topicDetail = cleanString(req.body.topicDetail);
  const message = cleanString(req.body.message);

  if (!name) throw httpError(400, 'name_required');
  if (name.length > 120) throw httpError(400, 'name_too_long');
  if (!email) throw httpError(400, 'email_required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'invalid_email');
  if (!isTopic(topic)) throw httpError(400, 'invalid_topic');
  if (topic === 'other' && !topicDetail) throw httpError(400, 'topic_detail_required');
  if (topicDetail.length > 160) throw httpError(400, 'topic_detail_too_long');
  if (!message) throw httpError(400, 'message_required');
  if (message.length > 4000) throw httpError(400, 'message_too_long');

  const created = await ContactMessage.create({
    name,
    email,
    topic,
    topicDetail: topic === 'other' ? topicDetail : undefined,
    message,
  });

  res.status(201).json({ data: serializeContactMessage(created) });
}

export async function listAdminContactMessages(req: Request, res: Response) {
  const page = parsePositiveInt(req.query.page, 1, 10000);
  const limit = parsePositiveInt(req.query.limit, 20, 100);
  const skip = (page - 1) * limit;

  const [messages, total] = await Promise.all([
    ContactMessage.find().sort({ createdAt: -1 }).skip(skip).limit(limit),
    ContactMessage.countDocuments(),
  ]);

  res.json({
    data: messages.map(serializeContactMessage),
    pagination: {
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
    },
  });
}
