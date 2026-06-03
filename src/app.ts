import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import morgan from 'morgan';
import mongoose from 'mongoose';
import { connectDB } from './config/db';
import { clerkAuth } from './middleware/auth';
import apiRouter from './routes';
import clerkWebhookRouter from './routes/webhooks/clerk';
import { normalizeError } from './utils/errors';

// Last-resort safety net: log stray async errors instead of letting an
// unhandled rejection terminate the process. Route-level handling above is
// still the primary mechanism; this only catches anything that slips through.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

const app = express();

app.set('trust proxy', 1);

const ALLOWED_ORIGINS = [
  process.env.FRONTEND_ORIGIN,
  'http://localhost:3000',
  'https://resolve-webapp.vercel.app',
].filter(Boolean) as string[];

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow server-to-server requests (no origin) and listed origins.
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: false, // we use the Authorization header, not cookies
  }),
);
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Ensures the DB is connected before a handler runs.
// Works for both the local Express server and serverless deployments.
async function ensureDb(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await connectDB();
    next();
  } catch (error) {
    console.error('Database connection error:', (error as Error).message);
    res.status(500).json({
      error: 'Database connection failed',
      message:
        process.env.NODE_ENV === 'production'
          ? 'Unable to connect to database'
          : (error as Error).message,
    });
  }
}

// Clerk webhook needs the RAW body for svix signature verification, so it MUST be
// mounted BEFORE express.json(). It connects its own DB for the user-sync writes.
app.use('/api/webhooks/clerk', ensureDb, clerkWebhookRouter);

// Populate req.auth on every request (does NOT reject unauthenticated requests).
app.use(clerkAuth);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (_req, res) => {
  res.json({ message: 'Resolve API is running' });
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    dbState: mongoose.connection.readyState,
  });
});

// Connect DB before the API routes, then mount them.
app.use('/api', ensureDb);
app.use('/api', apiRouter);

// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// Error handler — maps thrown values (incl. Clerk API errors like a missing user)
// to a safe { status, error } pair instead of crashing or leaking 500s.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const { status, error } = normalizeError(err);
  if (status >= 500) console.error(err);
  res.status(status).json({ error });
});

export default app;
