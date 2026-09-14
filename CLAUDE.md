# Relationship Mapper — Claude Code Instructions

## CRITICAL RULES (never break these)

1. **Database is PostgreSQL.** The file `prisma/schema.prisma` MUST have `provider = "postgresql"`. If you ever see `provider = "sqlite"`, stop and fix it immediately. Never change the provider to sqlite.

2. **Never remove datasource URLs from schema.prisma.** The `datasource db` block MUST always contain these three lines:
   ```prisma
   datasource db {
     provider  = "postgresql"
     url       = env("DATABASE_URL")
     directUrl = env("DIRECT_URL")
   }
   ```
   If any of these lines are missing, the build will fail and the live site will break.

3. **Do not change the Prisma generator config.** The generator block MUST stay as:
   ```prisma
   generator client {
     provider = "prisma-client-js"
   }
   ```
   Do NOT change it to `prisma-client` or add a custom `output` path. The standard `prisma-client-js` generates into `node_modules/@prisma/client`, which is the only configuration that works reliably on Vercel's serverless environment. The app imports from `@prisma/client` in `src/lib/prisma.ts` — do not change that import path either.

4. **Never push directly to `main`.** All changes go through a pull request from a feature branch. Branch protection is enabled and will reject direct pushes anyway. Follow the workflow in `claude-helpers/Deploy Changes to Live Site.md`.

5. **Always run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` before opening a PR.** CI will run these too, but catching them locally is faster and cheaper.

6. **Do not change `git config user.email`.** Use whatever email is already configured.

7. **Never force-push `main`.** Do not use `git push --force` or `git push -f` against `main`. Force-with-lease is acceptable on your own feature branches (see `claude-helpers/If Something Goes Wrong.md`).

8. **Never commit `.env` or `.env.local`.** Both are gitignored. If you see either staged, unstage it. All production secrets live in Vercel env vars, not in the repo. `.env.example` (tracked) lists every required variable with placeholder values — keep it current when adding new env vars to the app.

9. **Before opening or merging any PR, always run `git status` and show Barry the full list of uncommitted and untracked files.** Ask explicitly: "These files have local changes that are NOT in the PR — should any of them be included?" Do not proceed with the merge until Barry has answered. This prevents changes that exist only on the local machine from being left out of production. Barry is not a developer and may not know that unsaved local changes don't automatically go into a PR.

## Project Overview

- **App:** Relationship Mapper — tracks people, partners, and connections across offices
- **Framework:** Next.js 15 with React 19, TypeScript
- **Database:** PostgreSQL via Prisma ORM (Prisma 6, standard `prisma-client-js` generator)
- **Auth:** NextAuth.js (v5 beta)
- **Styling:** Tailwind CSS
- **Hosting:** Vercel team `jcrb-ajc`, project `relationship-mapper` (auto-deploys from `main` branch; every PR gets a preview URL). Production: `https://jcrb-relationship-mapper.vercel.app`
- **Database hosting:** Neon, installed as a Vercel marketplace integration on the `jcrb-ajc` team (resource `relationship-mapper-db`)
- **Repository:** Public on GitHub at `JCRB-AJC/relationship-mapper` (moved from `ethan-kaseff/relationship-mapper` in September 2026 — see `MIGRATION-LOG-2026-09.md`)
- **Node:** 22.x (see `.github/workflows/ci.yml`)

## Git & Deployment Flow

**Summary:** every change lives on a `work/<slug>` feature branch and reaches production via a PR that passes CI. Vercel auto-deploys `main` and gives every PR a preview URL.

```
  work/fix-foo  ──push──►  GitHub PR  ──CI passes──►  auto-squash-merge  ──►  main  ──►  Vercel deploys
                                                                                   └──►  preview URL per PR
```

Barry and Ethan both use this same flow. Never skip it.

**Always leave the repo clean after a merge.** Once a PR is merged, return to
`main`, `git pull`, delete the merged feature branch with `git branch -D`
(capital D — squash-merges aren't recognized by lowercase `-d`), run
`git remote prune origin`, and confirm `git status` is clean with only `main`
(or branches with genuinely unfinished work) remaining. Full checklist is
step 10 of `claude-helpers/Deploy Changes to Live Site.md`. This prevents stale
branches and junk files from accumulating.

| Barry says | File to read |
|------------|--------------|
| "Let's get started" / start of session / "start work" | `claude-helpers/Before Starting Work.md` |
| "Save" / "commit" | `claude-helpers/Save My Changes Locally.md` |
| "Push" / "deploy" / "push to live" | `claude-helpers/Deploy Changes to Live Site.md` |
| "Something broke" / deploy failed / push rejected | `claude-helpers/If Something Goes Wrong.md` |

## Environment Variables

- `.env.example` (tracked) — documents every required variable with placeholder values. Update this whenever the app starts reading a new `process.env.X`.
- `.env` (gitignored) — local dev values. Real DB/auth credentials live here on each developer's machine.
- `.env.local` (gitignored) — per-machine overrides; takes precedence over `.env`.
- **Vercel** — production / preview / development environment variables live in the Vercel project settings. Use `vercel env pull` to sync them into a local `.env.development.local` for dev parity.

When adding a new integration (Stripe, QuickBooks, etc.):
1. Add the variable to `.env.example` with a placeholder and a short comment.
2. Add it to Vercel for Production (and Preview/Development if needed): `vercel env add`.
3. Add it to the local `.env` / `.env.local` with the real dev value.
4. Reference it in code via `process.env.X`.

## Commands

| Command | What It Does |
|---------|--------------|
| `npm run dev` | Start local dev server |
| `npm run build` | Generate Prisma client + build for production |
| `npm run lint` | Check code for errors (must pass with 0 warnings) |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run typecheck` | Check TypeScript types |
| `npm test` | Run tests once |
| `npm run db:push` | Sync Prisma schema to database |
| `npm run db:studio` | Open database browser |
| `vercel env pull` | Sync Vercel env vars into local `.env.development.local` |

## Project Structure

```
src/
  app/              — Pages and API routes (Next.js App Router)
    api/            — REST API endpoints (auth, people, partners, events, stripe, quickbooks, etc.)
    dashboard/      — Main dashboard
    people/         — People list and detail pages
    partners/       — Partner list and detail pages
    relationships/  — Relationship management
    events/         — Event management with seating charts
    fundraisers/    — Fundraising campaigns (Stripe-backed)
    donate/         — Public donation pages
    happenings/     — Ad-hoc event tracking
    interactions/   — Interaction logging
    settings/       — App settings (lookup tables, annual event types)
    help/           — Help page
  components/       — Reusable UI components
    events/         — Event-specific components (modals, invite manager)
    seating/        — Seating chart components (floor plan, tables)
  lib/              — Shared utilities
    prisma.ts       — Prisma client singleton (imports from @prisma/client)
    auth.ts         — NextAuth.js configuration
    api-auth.ts     — API route authentication helpers
    api-error.ts    — Standardized API error responses
    office-filter.ts — Office-level data scoping
    stripe.ts       — Stripe client + helpers
    quickbooks.ts   — QuickBooks OAuth + sync helpers
    constant-contact.ts — Constant Contact OAuth + sync helpers
    currency.ts     — Currency formatting helpers
    validations/    — Zod schemas for request validation
  types/            — TypeScript type definitions
  hooks/            — Custom React hooks
prisma/
  schema.prisma     — Database schema (MUST stay PostgreSQL)
  seed.ts           — Database seeding script
claude-helpers/     — Step-by-step workflow instructions for Barry
.github/workflows/  — CI (lint, typecheck, test, build) — required for merge
```

## Key Architecture Patterns

### API Routes
All API routes follow this pattern:
1. Authenticate with `requireAuth()` or `requireNonConnector()`
2. Validate request body with Zod schemas from `src/lib/validations/`
3. Query database with Prisma, scoped to the user's office
4. Return JSON response or standardized error via `handleApiError()`

### Prisma Schema Rules
- The generator block must stay as `prisma-client-js` with no custom output (see Critical Rule #3)
- The datasource block must keep `url` and `directUrl` (see Critical Rule #2)
- All models use `@@map("snake_case")` for table names
- All fields use `@map("snake_case")` for column names
- Relations use `onDelete: Cascade` on join tables

### Validation
- Every API route that accepts a body uses Zod schemas from `src/lib/validations/`
- Schemas are re-exported from `src/lib/validations/index.ts`
- When adding new fields to a Prisma model, also update the matching validation schema
