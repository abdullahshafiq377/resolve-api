# App Runtime

Key files:

- `src/app.ts` builds the Express app used by serverless and local entrypoints.
- `src/server.ts` loads env, connects MongoDB, starts the local/long-lived server,
  and handles graceful shutdown.
- `src/config/db.ts` owns the cached MongoDB connection.
- `src/routes/index.ts` mounts the public API router under `/api`.
- `src/routes/admin/index.ts` mounts admin feature routers under `/api/admin`.

Important implementation details:

- Clerk webhooks are mounted before `express.json()` at `/api/webhooks/clerk`
  because that route needs the raw body for Svix verification.
- `ensureDb` runs for `/api/*` requests before route handlers.
- `clerkAuth` is mounted globally and populates auth context; individual routes
  still opt into `requireSignedIn`, `requireModerator`, `requireStandard`, or
  `requireSuperAdmin`.
- The API exposes `/health` outside the `/api` router.
- Vercel routes traffic to `src/app.ts`; long-lived deployments should run
  `src/server.ts` via `npm start`.

Operational notes:

- `npm run typecheck` is the backend verification command.
- Data scripts live under `src/scripts/`; current package scripts include
  category/region/billing/article-author migrations, article seeding, AI summary
  migration, embedding backfill, and vector index creation.

