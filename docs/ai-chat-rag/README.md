# AI Chat And RAG

Key files:

- `src/controllers/chat.ts`
- `src/routes/chat.ts`
- `src/middleware/chatRateLimit.ts`
- `src/lib/gemini.ts`
- `src/services/articleEmbeddings.ts`
- `src/models/ChatUsage.ts`
- `src/models/Conversation.ts`
- `src/models/ChatMessage.ts`
- `src/models/ArticleChunk.ts`

Routes:

- All chat routes require sign-in.
- `POST /api/chat` streams SSE frames.
- `GET /api/chat/usage` returns rolling-window usage.
- Paid users can list, read, rename, and delete conversations under
  `/api/chat/conversations`.

Tiers and limits:

- Free: 4 successful messages per rolling 24-hour window.
- Standard: 30 successful messages per rolling 24-hour window.
- Premium: uncapped daily usage.
- Paid tiers (`standard` and `premium`) get persisted conversation history.
- A separate in-memory burst limiter applies to all signed-in users.

Model selection:

- Product keys are `velo`, `core`, and `max`.
- Free can use `velo`; standard can use `velo` and `core`; premium can use all
  three.
- Backend clamps unknown or out-of-tier model keys in `resolveModel`.
- Provider model IDs come from `GEMINI_CHAT_MODEL`,
  `GEMINI_CHAT_MODEL_THINKING`, and `GEMINI_CHAT_MODEL_PRO`.

RAG behavior:

- `scope: article` uses the target article body as context.
- `scope: resolve` retrieves vector chunks from `ArticleChunk`.
- Embeddings use Gemini through `src/lib/gemini.ts`; vector dimensions are
  controlled by `GEMINI_EMBED_DIM`.

Developer gotchas:

- Quota increments after a successful non-empty stream, not before Gemini is
  called.
- In-memory rate limiting is process-local; use a shared store before relying on
  it across multiple instances.

