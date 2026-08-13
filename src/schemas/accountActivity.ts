import mongoose from 'mongoose';
import { z } from 'zod';

// Body schema shared by the two article-scoped writes on the account Activity
// section: POST /api/account/saved and POST /api/account/reading-history. Both
// take nothing but the article's id — timestamps and the reader's identity are
// server-owned.
export const articleRefSchema = z.object({
  articleId: z
    .string()
    .refine((value) => mongoose.Types.ObjectId.isValid(value), {
      message: 'A valid article id is required.',
    }),
});

export type ArticleRefInput = z.infer<typeof articleRefSchema>;
