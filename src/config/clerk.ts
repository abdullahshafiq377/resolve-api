import { createClerkClient } from '@clerk/backend';

// Shared Clerk Backend API client (used by webhook sync + admin user management).
export const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
