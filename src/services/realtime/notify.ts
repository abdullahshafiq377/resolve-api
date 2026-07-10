import { getIo, userRoom } from './server';

export interface NotificationPayload {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string;
  requestId: string | null;
  commentId?: string | null;
  createdAt: string;
}

// Best-effort socket push to a single user's room. No-op (swallowed) when the
// socket server is not initialised — e.g. on the Vercel serverless path or early
// boot. The DB row is the source of truth; the recipient hydrates via REST.
export function notify(userId: string, payload: NotificationPayload): void {
  try {
    getIo().to(userRoom(userId)).emit('notification', payload);
  } catch {
    // Socket server not available — intentionally ignored.
  }
}
