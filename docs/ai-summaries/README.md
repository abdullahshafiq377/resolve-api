# Article AI Summaries

Key files:

- `src/models/ArticleSummary.ts`
- `src/controllers/aiSummary.ts`
- `src/routes/admin/aiSummary.ts`
- `src/services/aiSummaryGeneration.ts`
- `src/services/aiSummaryValidation.ts`
- `src/services/aiSummaryRateLimit.ts`
- `src/routes/admin/articles.ts`

Route shape:

- The summary router is mounted at
  `/api/admin/articles/:id/ai-summary`.
- Supported admin actions are get, generate, update, and approve.
- The standalone `src/routes/admin/aiSummary.ts` file is not mounted directly in
  `src/routes/admin/index.ts`; it is nested through article admin routes.

Data shape:

- Summaries are attached to an `articleId`.
- Supported formats are `bullets` and `paragraph`.
- Only approved summaries are surfaced on public article responses.
- Metadata records generated/edited/approved users and timestamps.

Developer gotchas:

- Validation is strict about summary content shape. Use
  `normalizeAiSummaryContent` instead of accepting arbitrary mixed data.
- Generation is rate-limited in memory by moderator user ID.

