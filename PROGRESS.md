# Progress

## M1 - Foundation ✅ (2026-10-26)

**Done when:** I can sign up, invite a user, and log in with roles enforced. Verified with the
automated tests and by hand in the browser (sign up → verify email → invite reviewer → accept →
reviewer sees a read-only team page).

### Built

- **Monorepo:** pnpm workspaces, strict TypeScript, ESLint + Prettier, GitHub Actions CI
  (lint, typecheck, test).
- **Zero-install dev DB:** `pnpm dev` starts MongoDB itself (or uses one already on :27017).
  `docker-compose.yml` is provided for when Docker is installed.
- **packages/shared:** Zod schemas for auth, users and orgs, plus role helpers. The API and the
  web app both use them.
- **apps/api:**
  - Auth: sign up (creates org + owner), email verification, login, logout, refresh-token rotation
    with reuse detection, forgot/reset password, TOTP 2FA with 8 single-use recovery codes.
  - Users: list, invite (email link, 7 days), revoke invite, change role, remove (signed out
    immediately). Rules: admins can't touch owners, nobody manages themselves, an org always keeps
    at least one owner.
  - Organisation settings, an append-only audit log, health endpoints (`/health`, `/health/ready`).
  - Tenant-scoping Mongoose plugin that fails closed. orgId always comes from the session.
  - Security: helmet, CORS, rate limits, CSRF, Zod on every input, pino logs with request IDs.
  - Dev mailer shows emails at `/dev/emails`. Seed script and make-superadmin script.
- **apps/web:** sign-up, login (+2FA step), forgot/reset password, verify email, accept invite,
  app shell with role-aware navigation, Organisation / Team / Security (2FA) / Audit log pages,
  placeholder pages for later milestones, dev mailbox.

### How to try it

```bash
pnpm install
pnpm dev            # http://localhost:5173
pnpm seed           # optional demo users (see README)
pnpm test           # 23 tests
```

### Tests

- `packages/shared`: role helpers.
- `apps/api/test/auth.test.ts`: sign-up/verify, login, CSRF, refresh rotation + reuse detection,
  logout, password reset kills sessions, 2FA + recovery codes.
- `apps/api/test/users.test.ts`: invites, role matrix, owner protections, immediate role changes,
  removal ends sessions.
- `apps/api/test/tenancy.test.ts`: unscoped queries throw; org A cannot read or change org B through
  the API; audit log is append-only.

### Known gaps / decisions

- Google/Microsoft sign-in is not built yet (spec says optional). It can come with the M3 mailbox
  OAuth work.
- 2FA is available to every role and recommended for owners/admins, but not forced. An org setting
  "require 2FA for admins" can be added in M10.
- Rate limiting uses an in-memory store. Switch to Redis when there is more than one API instance.
- Email: console/dev mailer only. A real provider (Postmark/Resend free tier) plugs in behind
  `Mailer` in M8 or earlier when needed.
- The super-admin flag exists (script); the panel itself is M10.
- One user belongs to one org (MVP decision).

## Next: M2 - Catalogue and customers

CSV imports with column mapping (products, customers, prices, cross-references), list/search pages,
MockConnector with sync. Done when a 5,000-product catalogue imports and searches quickly.
