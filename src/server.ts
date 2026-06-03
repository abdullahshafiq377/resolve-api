import 'dotenv/config';
import type { Server } from 'http';
import app from './app';
import { connectDB, closeDB } from './config/db';

const PORT = Number(process.env.PORT) || 3000;

async function start(): Promise<void> {
  try {
    await connectDB();

    const server: Server = app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });

    const shutdown = async (signal: string): Promise<void> => {
      console.log(`${signal} received, shutting down`);
      server.close(async () => {
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
