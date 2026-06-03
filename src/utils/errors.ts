import { isClerkAPIResponseError } from '@clerk/backend/errors';

export interface HttpError extends Error {
  status?: number;
}

// Build an Express-friendly error carrying an HTTP status.
export function httpError(status: number, message: string): HttpError {
  return Object.assign(new Error(message), { status });
}

interface NormalizedError {
  status: number;
  error: string;
}

// Map any thrown value to a safe { status, error } pair.
// Clerk Backend API errors (e.g. getUser on a missing user) carry an HTTP status
// we surface directly instead of letting them bubble up as a 500/crash.
interface ClerkErrLike {
  status?: number;
  errors?: { code?: string }[];
}

export function normalizeError(err: unknown): NormalizedError {
  if (isClerkAPIResponseError(err)) {
    const ce = err as ClerkErrLike;
    const status = ce.status ?? 500;
    if (status === 404) return { status: 404, error: 'user_not_found' };
    // First Clerk error code is the most actionable identifier.
    const code = ce.errors?.[0]?.code;
    return { status, error: code ?? 'clerk_error' };
  }
  const e = err as HttpError;
  return { status: e?.status ?? 500, error: e?.message || 'Internal Server Error' };
}
