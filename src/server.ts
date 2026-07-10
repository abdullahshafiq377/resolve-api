import 'dotenv/config';
import { createServer } from 'http';
import app from './app';
import { connectDB, closeDB } from './config/db';
import { initSocketServer } from './services/realtime/server';

const PORT = Number(process.env.PORT) || 3000;

async function start(): Promise<void> {
  try {
    await connectDB();

    // Long-lived process (local + Render): attach socket.io to the same HTTP
    // server. The Vercel serverless entry (app.ts) does NOT call this, so
    // notify() no-ops there and clients hydrate notifications via REST.
    const httpServer = createServer(app);
    initSocketServer(httpServer);

    httpServer.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });

    const shutdown = async (signal: string): Promise<void> => {
      console.log(`${signal} received, shutting down`);
      httpServer.close(async () => {
        await closeDB();
        process.exit(0);
      });
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (err) {
    console.error('Fatal startup error:', (err as Error).message);
    await closeDB().catch(() => {});
    process.exit(1);
  }
}

start();
