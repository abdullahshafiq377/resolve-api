# Resolve API Feature Notes

These notes are intentionally short and source-derived. Use them as a map before
editing the backend, then verify details in `src/`.

Feature folders:

- `app-runtime/` - Express app assembly, DB, deployment entrypoints.
- `auth-billing-users/` - Clerk auth, plan tiers, moderator and super-admin rules.
- `articles/` - Article CRUD, public reads, uploads, summaries, embeddings.
- `shorts/` - Shorts CRUD, public feed, uploads, view counting.
- `taxonomy/` - Categories and regions.
- `ai-chat-rag/` - Streaming chat, tiers, conversation history, RAG.
- `resolve-brief/` - Personalized and generic Brief generation.
- `ai-summaries/` - Article AI summary storage and moderation.
- `contact-messages/` - Contact form intake and admin review.

