import { z } from 'zod';

// Server-side schema for POST /api/research-requests. Messages and bounds mirror
// the previous inline checks in controllers/researchRequests.ts (title 8–120,
// description 20–500) so behaviour is unchanged. categoryId is validated loosely
// here (string | null | omitted); the controller still resolves it against the DB
// (ObjectId shape, existence, active) and returns invalid_category / inactive_category.
const TITLE_MSG = 'Title must be 8–120 characters.';
const DESC_MSG = 'Description must be 20–500 characters.';

export const submitResearchRequestSchema = z.object({
  title: z.string({ error: TITLE_MSG }).trim().min(8, TITLE_MSG).max(120, TITLE_MSG),
  description: z
    .string({ error: DESC_MSG })
    .trim()
    .min(20, DESC_MSG)
    .max(500, DESC_MSG),
  categoryId: z.union([z.string(), z.null()]).optional(),
});

export type SubmitResearchRequestInput = z.infer<typeof submitResearchRequestSchema>;
