# Taxonomy: Categories And Regions

Key files:

- `src/models/Category.ts`
- `src/models/Region.ts`
- `src/controllers/categories.ts`
- `src/controllers/regions.ts`
- `src/services/categories.ts`
- `src/services/regions.ts`
- `src/routes/categories.ts`
- `src/routes/admin/categories.ts`
- `src/routes/admin/regions.ts`

Categories:

- Public route: `GET /api/categories`.
- Admin routes: list, create, update, delete under `/api/admin/categories`.
- Public lists return active categories ordered for navigation.
- Admin list includes article/short usage counts and a `locked` flag.
- Categories in use by articles or shorts cannot be changed/deleted by the
  backend.
- Articles and shorts store `categoryId`; legacy `category` is compatibility
  output.

Regions:

- Admin routes live under `/api/admin/regions`.
- Regions are used by articles and Resolve Brief preferences/segments.
- Admin list includes usage counts and lock/global flags.
- Region services provide default/global region helpers and validate active
  region IDs for article and Brief workflows.

Developer gotchas:

- Slugs are generated server-side from titles.
- Keep category and region changes coordinated with Brief preferences and article
  filters; both features depend on these IDs.

