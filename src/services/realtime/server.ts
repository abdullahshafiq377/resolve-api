import { Server as IoServer } from 'socket.io';
import type { Server as HttpServer } from 'http';
import { verifyToken } from '@clerk/backend';

// socket.io server attached to the long-lived Node process (server.ts). It is NOT
// initialised on the Vercel serverless path (app.ts) — there, notify() no-ops and
// clients hydrate missed notifications via REST. Deployment target: Render.

let io: IoServer | null = null;

function userRoom(userId: string): string {
  return `user:${userId}`;
}

export function initSocketServer(httpServer: HttpServer): IoServer {
  const allowedOrigins = [
    process.env.FRONTEND_ORIGIN,
    'http://localhost:3000',
    'https://resolve-webapp.vercel.app',
  ].filter(Boolean) as string[];

  io = new IoServer(httpServer, {
    cors: { origin: allowedOrigins, credentials: false },
  });

  // Authenticate every connection via the Clerk session token in the handshake.
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('unauthorized'));
    try {
      const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY! });
      if (!payload.sub) return next(new Error('unauthorized'));
      socket.data.clerkUserId = payload.sub;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.data.clerkUserId as string;
    // Each user gets a private room keyed by Clerk user ID. A user only ever
    // receives events addressed to their own ID (no per-request broadcast).
    socket.join(userRoom(userId));
  });

  console.log('Socket.io server initialised');
  return io;
}

export function getIo(): IoServer {
  if (!io) throw new Error('Socket server not initialized');
  return io;
}

export { userRoom };
