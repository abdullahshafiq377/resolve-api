import { z } from 'zod';

// Server-side schema for PATCH /api/account/notification-preferences. Every
// switch is optional so the page can send just the one the user flipped; an
// empty body is rejected rather than silently writing nothing.
export const updateNotificationPreferencesSchema = z
  .object({
    briefReady: z.boolean().optional(),
    researchUpdates: z.boolean().optional(),
    commentReplies: z.boolean().optional(),
    weeklyNewsletter: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one preference must be provided.',
  });

export type UpdateNotificationPreferencesInput = z.infer<
  typeof updateNotificationPreferencesSchema
>;
