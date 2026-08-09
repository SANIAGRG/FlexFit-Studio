# FlexFit Studio

Class booking and membership management for a single gym site. Members book classes, buy memberships and spend class credits. Staff run the front desk, manage trainers and pull reports. Companies buy credit pools their employees book against.

## Refactor notes

This fork is mid-refactor: consolidating duplicated booking/reschedule logic in `src/server/routers/` without changing any existing behavior (same inputs, outputs, error codes, message strings, edge cases). Full reasoning lives in [`documents/`](./documents) — start at [`documents/README.md`](./documents/README.md). Short version:

- **What's done:** test infrastructure (`vitest.config.ts`, `test/helpers/`), and behavior specs + characterization tests for `bookings`, `corporate-bookings`, and `reschedules` (47 tests, all passing against the current, unrefactored code — see [`documents/coverage-matrix.md`](./documents/coverage-matrix.md)).
- **What's not done yet:** the actual extraction (`src/server/booking/`), `payments` tests, and anything in Tier 2.
- **What deliberately won't change:** individual and corporate bookings stay on separate tables with separate capacity counts, including the "10-person room can hold 10 individual + 10 corporate bookings" quirk — merging that count would fix a bug that wasn't in scope. Full reasoning in [`documents/architecture-decisions.md`](./documents/architecture-decisions.md); the bug itself (and six others) is written up in [`documents/known-issues.md`](./documents/known-issues.md).
- **Run the tests:** `pnpm test`.

## Requirements

Node 20 or newer, and pnpm. If you don't have pnpm:

```bash
npm install -g pnpm
```

The database is SQLite and lives in a file. There's no server to install and no account to create.

## Getting set up

```bash
pnpm install
pnpm db:push
pnpm db:seed
pnpm dev
```

That gets you a populated studio at http://localhost:3000 with a couple of weeks of classes either side of today.

`db:push` creates `flexfit.db` and applies the schema. `db:seed` fills it with sample members, plans, classes and bookings.

## Signing in

| Role    | Email                  | Password   |
| ------- | ---------------------- | ---------- |
| Admin   | admin@flexfit.test     | admin123   |
| Trainer | arjun@flexfit.test     | trainer123 |
| Member  | rahul.k@example.com    | member123  |

Every seeded member uses `member123`. The other member emails are in `src/db/seed.ts`.

## Commands

| Command         | What it does                                      |
| --------------- | ------------------------------------------------- |
| `pnpm dev`      | Development server on port 3000                    |
| `pnpm build`    | Production build                                   |
| `pnpm db:push`  | Apply the schema in `src/db/schema.ts`             |
| `pnpm db:seed`  | Wipe the data and reseed                           |
| `pnpm db:reset` | Delete the database file, then push and seed again |

`db:reset` is the one you want when the data gets into a state you don't like. It's destructive and it's meant to be.

## Two things that will waste your time

Don't run `pnpm build` while `pnpm dev` is running. The build writes over the directory the dev server is using and the app starts throwing `MODULE_NOT_FOUND`. Nothing is actually broken. Stop the dev server, delete `.next`, start it again. If you want to typecheck while the server is up, use `npx tsc --noEmit` instead.

If you're changing anything in `src/db/schema.ts`, run `pnpm db:push` afterwards or the app and the database will disagree with each other in confusing ways.

## Layout

```
src/
  app/          routes and pages
  components/   shared components
  db/           schema, client, seed data
  lib/          helpers
  server/       tRPC routers
documents/      empty, for your own notes
```
