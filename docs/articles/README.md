# Articles

Key files:

- `src/models/Article.ts`
- `src/controllers/articles.ts`
- `src/routes/articles.ts`
- `src/routes/admin/articles.ts`
- `src/config/s3.ts`
- `src/lib/articleText.ts`
- `src/services/articleEmbeddings.ts`

Model shape:

- Articles store `title`, unique `slug`, `excerpt`, `authorId`, `categoryId`,
  `regionIds`, featured image fields, optional audio fields, `template`,
  `publishDate`, `status`, Tiptap JSON `body`, and optional RAG `bodyHash`.
- Templates are `standard`, `longform`, and `visual`.
- Statuses are `draft` and `published`.

Routes:

- Public: `GET /api/articles`, `GET /api/articles/:slug`.
- Admin: `GET/POST/PUT/DELETE /api/admin/articles`, slug check, slug lookup, and
  upload URL creation.
- Public listing always forces `status: published`; admin listing can filter
  statuses and flags.

Important behavior:

- Authors must resolve to the super admin or an active moderator.
- Only published articles can be featured or highlighted.
- Featured max is 5 published articles; highlight max is 3 published articles.
- Draft transitions clear `featured` and `highlight`.
- Article image/audio uploads use signed S3 URLs from
  `/api/admin/articles/upload-url`.
- Audio uploads are supported as article media and stored as `audioUrl/audioKey`.
- Published article body text is embedded into `ArticleChunk` records for RAG.
  Drafting or deleting an article purges its chunks.
- Public article responses can include an approved AI summary.

Developer gotchas:

- Body content is Tiptap/ProseMirror JSON. Keep `src/lib/articleText.ts` aligned
  with frontend rendering when adding new node types.
- Legacy `category` strings are still serialized for compatibility, but
  `categoryId` is the source field.

