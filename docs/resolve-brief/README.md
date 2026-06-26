# Resolve Brief

Key files:

- `src/models/BriefPreference.ts`
- `src/models/BriefSegment.ts`
- `src/models/BriefRecipient.ts`
- `src/models/BriefGenerationRun.ts`
- `src/controllers/brief.ts`
- `src/controllers/adminBriefs.ts`
- `src/controllers/cron.ts`
- `src/services/resolveBriefGeneration.ts`
- `src/services/briefPreferences.ts`
- `src/services/briefPremium.ts`
- `src/services/briefGeneric.ts`
- `src/services/briefEmail.ts`
- `src/routes/brief.ts`
- `src/routes/admin/briefs.ts`
- `src/routes/cron.ts`

User routes:

- `GET/PUT /api/brief/preferences` is signed-in.
- `GET /api/brief/generic` is signed-in and returns the shared free Brief.
- `GET /api/brief/latest`, `/archive`, and `/:id` require standard-or-above.

Admin and cron routes:

- Admin Brief routes are moderator-only under `/api/admin/briefs`.
- Admins can list, generate, inspect, update, approve, reject, regenerate, and
  retry emails for segments.
- `POST /api/cron/resolve-brief` runs generation from cron after cron-secret
  validation.

Important behavior:

- Preferences are keyed by Clerk user ID and store enabled flags plus category
  and region selections.
- Segments store generated story selections, summaries, source article IDs, and
  approval state.
- Recipients snapshot the preference used for a generated Brief.
- Eligibility checks Clerk billing subscription slugs `standard`, `premium`, and
  legacy `premium_plan`; moderators and super admin are eligible.
- Email delivery uses Resend through `briefEmail`.

Developer gotchas:

- Date logic is Pakistan-date aware in `briefDates.ts`.
- Generation can fall back when Gemini output is unavailable or invalid; inspect
  `generationError` and admin segment status before retrying.

