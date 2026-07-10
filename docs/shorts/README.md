# Shorts

Key files:

- `src/models/Short.ts`
- `src/models/ShortView.ts`
- `src/controllers/shorts.ts`
- `src/controllers/admin/shorts.ts`
- `src/routes/shorts.ts`
- `src/routes/admin/shorts.ts`
- `src/config/s3.ts`

Model shape:

- Shorts store `title`, unique `slug`, optional `description`, required video
  URL/key, optional thumbnail URL/key, optional duration, `categoryId`, tags,
  `featured`, `status`, `publishedAt`, and `views`.
- Statuses are `draft`, `published`, and `archived`.

Routes:

- Public: `GET /api/shorts`, `GET /api/shorts/:slug`,
  `POST /api/shorts/:id/view`.
- Admin: upload URL, list, detail, create, patch, archive, and permanent delete.

Important behavior:

- Public list returns featured, published shorts.
- Public detail returns the selected short plus the published feed used by the
  player.
- Creating a short requires title, video URL, video key, and category.
- Publishing sets `publishedAt` if it was missing.
- Archive is a status update; permanent delete hard-deletes.
- `ShortView` deduplicates views per `(shortId, ip)` with a 24-hour TTL.

Developer gotchas:

- Category display fields are serialized from `categoryId`; legacy `category`
  remains only for compatibility.
- There is no backend max-count rule for featured shorts in current source.

