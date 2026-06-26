# Auth, Billing, And Users

Key files:

- `src/middleware/auth.ts`
- `src/routes/admin/users.ts`
- `src/services/users.ts`
- `src/routes/webhooks/clerk.ts`
- `src/models/User.ts`

Current authority model:

- Authentication is Clerk.
- Super admin is derived from `SUPER_ADMIN_USER_ID`.
- Moderator is the only role mirrored in Clerk metadata and the local `User`
  mirror.
- Plan tier is read from Clerk plan checks, not from role metadata.
- Current tiers are `free`, `standard`, and `premium`.
- Current plan keys are `user:standard` and `user:premium`; legacy
  `user:premium_plan` is still treated as premium.
- Moderators and the super admin inherit premium access.

Backend gates:

- `requireSignedIn` accepts any signed-in user.
- `requireModerator` accepts moderators and the super admin.
- `requireStandard` accepts standard or premium users, moderators, and super admin.
- `requirePremium` accepts premium users, moderators, and super admin.
- `requireSuperAdmin` accepts only `SUPER_ADMIN_USER_ID`.

Admin user routes:

- `GET /api/admin/users` lists Clerk users for moderators.
- `GET /api/admin/users/moderators` returns selectable authors.
- `POST /api/admin/users/:id/role` promotes/demotes moderators; super-admin only.
- `POST /api/admin/users/:id/ban` and `/unban` are moderator-or-above, but cannot
  target moderators or the super admin.
- `DELETE /api/admin/users/:id` is super-admin only and soft-deletes the local
  mirror row after deleting the Clerk user.

Developer gotchas:

- Frontend plan hooks are UI hints only. Backend route middleware is the source
  of enforcement.
- The local `User` model preserves author references after Clerk deletion through
  `deletedAt`.

