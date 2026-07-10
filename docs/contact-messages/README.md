# Contact Messages

Key files:

- `src/models/ContactMessage.ts`
- `src/controllers/contactMessages.ts`
- `src/routes/contact.ts`
- `src/routes/admin/contactMessages.ts`
- `src/routes/index.ts`
- `src/routes/admin/index.ts`

Routes:

- Public intake: `POST /api/contact`.
- Admin review: `GET /api/admin/contact-messages`.

Data shape:

- Messages store name, email, topic, optional topic detail, message text, and
  timestamps.
- Current topics are `story_tip`, `membership`, `partnership`, and `other`.
- Admin listing is paginated.

Developer gotchas:

- Public intake is unauthenticated, so keep validation and abuse controls close
  to `createContactMessage` when extending the feature.
- The admin route is protected by `requireModerator`.

