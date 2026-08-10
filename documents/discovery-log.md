# Discovery log

How current behavior was worked out, in the order it happened. This is the method, not just the conclusions — kept because the brief grades how the problem was approached, not only what was found.

## Session: 2026-08-09 (Aug 8 work)

### Setup

```
pnpm install
pnpm db:push
pnpm db:seed
pnpm dev
```

All green on first try. Seed produced 16 users, 6 plans, 12 memberships, 96 classes, 791 bookings, 96 checkins, 5 notifications.

**Environment note:** this environment has no interactive browser tool available, so "log in as admin/trainer/member and walk every flow" was done two ways instead of by clicking through the UI:

1. Reading every router in `src/server/routers/` end to end (all mutations and queries, not just the ones named in the brief) to build a source-level model of behavior.
2. Smoke-testing the running dev server over HTTP: fetched `/`, `/login`, `/schedule` (200s), then drove the real tRPC endpoint over `curl` — `auth.login` as `rahul.k@example.com`, followed by `bookings.mine` — to confirm the login → session-cookie → protected-query path actually works end to end on seeded data, not just in isolation from source reading.

This is weaker evidence than an actual click-through for UI-layer bugs (rendering, client-side validation, loading states) but equivalent or stronger for the server-side behavior this refactor touches, since every rule in question lives in a router, not a component. Flagged here rather than silently substituted.

### Reading order

1. `src/db/schema.ts` — establishes the data model before anything else. Notable: `bookings` and `corporateBookings` are structurally near-identical siblings (same status enum, same `creditsUsed`/`bookedAt`/`cancelledAt` shape) but are genuinely separate tables with no foreign key or view tying them together.
2. `src/server/trpc.ts` — context and procedure levels. `ctx` is `{ db, user, token }`. `createContext()` calls `cookies()` from `next/headers`, which only works inside a Next.js request — this is the fact that shapes the whole test-infra design (see Step 0 below).
3. `src/server/routers/bookings.ts`, `corporate-bookings.ts`, `reschedules.ts` — read in full, not skimmed, because the brief's central claim (duplicated occupancy logic) lives in exactly these three plus two more call sites.
4. `src/server/routers/classes.ts`, `admin.ts` — found the remaining two occupancy-counting sites here.
5. `src/server/routers/auth.ts`, `notifications.ts`, `payments.ts`, `src/lib/password.ts`, `src/db/seed.ts` — read for corroboration of specific claims (see below) and general orientation.

### What was verified, and how

The handover brief (`../../Claude code handover.md`) states its own findings were corrected once already and says to verify before trusting it. Everything below was checked directly against source in this session, not taken on the brief's word:

- **Six occupancy-counting sites, not four.** Confirmed by grepping the actual count queries: `bookings.book` (`bookings.ts:127-134`, counts `status = 'booked'`), `corporateBookings.book` (`corporate-bookings.ts:131-139`, same), `reschedules.reschedule` (`reschedules.ts:163-168`), `reschedules.validateReschedule` (`reschedules.ts:367-372` — this file has the check duplicated a second time internally, once in the mutation and once in the query), `classes.list` → `spotsLeft`/`full` (`classes.ts:36-40`, counts individual `bookings` only), `admin.classUtilisation` (`admin.ts:72-76`, counts `status in ('booked','attended')` — the odd one out). Six sites, five different pieces of code (validateReschedule and reschedule duplicate the same check), and `admin.classUtilisation` is the one that would silently break if naively folded into the same helper as the other five, because it counts a different status set.
- **Individual and corporate bookings are mutually invisible.** Confirmed: `bookings.book`'s capacity check only queries the `bookings` table; `corporateBookings.book`'s only queries `corporateBookings`. A class with `capacity: 10` can genuinely hold 10 booked + 10 corporate-booked before anyone is waitlisted. `classes.list`'s `spotsLeft`/`full` (the number members actually see) is computed from `bookings` alone, so a class full of corporate bookings shows as empty to an individual member browsing the schedule. This is a real, currently-shipping split-brain, not a contrived edge case — traced by reading the two `book` mutations side by side.
- **`reschedules.ts` has no corporate path.** Confirmed by import list: `reschedules`, `bookings`, `classes`, `memberships` only — no `corporateBookings` import, no reference to the word "corporate" anywhere in the file. There is no corporate equivalent router either (`corporate-bookings.ts` has no `reschedule` procedure). Corporate bookings cannot be rescheduled today; only cancelled and rebooked, which is a materially different flow (loses the "keep your queue position" semantics reschedule gives individual bookings).
- **`activeMembershipFor` is dead code in `reschedules.ts`.** Defined at lines 22-39, matches the same-named helper in `bookings.ts` byte-for-byte, and is never called anywhere in the file. Confirmed by reading the whole file — `reschedule` and `validateReschedule` never check membership status at all. This is the tell that reschedule doesn't verify the member still has a valid membership before letting them move to a different class.
- **`hoursUntil` triplicated identically.** `bookings.ts:16-18`, `corporate-bookings.ts:20-22`, `reschedules.ts:18-20` — diffed character-for-character, they're the same function.
- **Constants differ intentionally.** `FREE_CANCELLATION_HOURS = 12` (`bookings.ts:11`), `CORPORATE_FREE_CANCELLATION_HOURS = 24` (`corporate-bookings.ts:18`), `FREE_RESCHEDULE_HOURS = 4` (`reschedules.ts:16`). All three are named differently in source already — nobody merged them into one number, which is itself evidence they're meant to diverge.
- **`UNLIMITED_CREDITS = 999` sentinel behavior.** Confirmed in `bookings.ts` `book`: `unlimited = membership.creditsRemaining >= UNLIMITED_CREDITS`, and if unlimited, the credit deduction is skipped — but `creditsUsed: cls.creditCost` is still recorded on the booking row either way (`book`, line ~143). So `cancel`'s refund check (`row.booking.creditsUsed > 0`) sees a nonzero value and reports `refunded: true` for an unlimited member even though no credits ever moved. Confirmed by reading `book` and `cancel` together.
- **Seven bugs.** Each one below was traced to specific line numbers rather than accepted from the brief; see `known-issues.md` for the full write-up with repro steps. All seven held up under source verification. One correction to the brief's framing: bug 6 (`waitlist_promotion` notification type) — confirmed by grep that the only place this literal string appears is `src/db/seed.ts:323` (sample data) and the schema enum; the actual promotion code path in `bookings.ts` `cancel` (lines ~213-252) never inserts a notification of any kind. So it's not just an unused *type*, promotion never notifies the promoted member at all, regardless of type.

### Surprises

- The two `book` mutations and the two `cancel` mutations (individual vs. corporate) are close enough to be a diff exercise, but not identical — corporate's waitlist-promotion credit logic (`if (company.creditPoolBalance >= row.cls.creditCost)`) is structurally different from individual's (`Math.max(0, ...)` unconditionally), which is bug 1. It would be easy to "fix" one to match the other while extracting and not notice that's a behavior change in whichever one loses.
- `admin.classUtilisation` counting `attended` in addition to `booked` looks like a bug at first glance (inconsistent with the other five sites) but on reflection is *more* correct for its purpose — utilisation should include people who showed up, not just people currently holding a slot for a future class. Initial assumption ("this is just another duplicate to merge") was wrong; corrected after reading what the field is used for (a past-oriented report, per `admin/reports/page.tsx`, not a live capacity check).
- `reschedule`'s target-class matching requires `targetClass.name !== originalClass.name` to fail — i.e., you can only reschedule within the same class *name* (e.g. Sunrise Yoga → a different Sunrise Yoga session), not to an arbitrary different class. This isn't stated anywhere except the check itself; worth calling out explicitly in the behavior spec since it's the kind of constraint a reviewer would test for.

### Next in this log

Continued in this session: test infrastructure (Step 0), then `behavior-spec.md` + characterization tests for `bookings`, `corporate-bookings`, `reschedules` in that priority order.

## Second pass, 2026-08-09: `admin.classUtilisation` is not just a different status set — it's broken

The earlier surprise note above ("`admin.classUtilisation` counting `attended` ... is *more* correct for its purpose") was true as far as it went but incomplete — it explains why the query's *intent* (a different status set from the other five occupancy sites) is reasonable, and stopped there without ever checking whether the query actually *executes* that intent. It doesn't. Recorded here rather than silently edited into the original note, because the gap between "I read the code and the intent looked right" and "I ran the code and checked the numbers" is itself the finding.

**How this was found.** A separate planning document (`Bug fixed.md`, written independently) claimed Drizzle renders the subquery's column references unqualified when `classUtilisation`'s outer query has only one table in scope, causing the `WHERE` clause to resolve entirely inside the subquery's own `bookings` scope instead of correlating to the outer `classes` row. Rather than accept that claim, it was re-derived from scratch:

1. **`.toSQL()` on the exact query shape**, run via a throwaway `tsx` script (not read from documentation, generated live from the actual Drizzle client and the actual query builder chain copied from `admin.ts`). Confirmed the generated SQL literally reads `where "class_id" = "id"` — both unqualified — and separately confirmed the sibling query in `classes.ts` (which has a `leftJoin`) renders everything qualified. This is the method worth remembering: when a claim is about what a query-builder library *generates*, the fastest and most convincing check is to generate it and read it, not to reason about the library's documented behavior.
2. **The same technique against the real seeded database**, not a synthetic example — ran the buggy query and a manually-correlated equivalent side by side against `flexfit.db` and diffed the output row by row. This is what turned "the SQL looks wrong" into "here is the exact wrong number next to the exact right number for the same class," which is a categorically more convincing form of evidence than the SQL text alone.
3. **Widened the audit rather than trusting the source document's own scope claim.** It stated "the repo contains exactly two raw correlated subqueries." Grepping the whole `src/server/routers/` tree for nested `SELECT`/`select` inside `sql` templates found seven, not two — five more inside `reschedules.ts`'s `history` query, never mentioned. Checked each of those five with the same `.toSQL()` technique before concluding they were safe (their outer query already joins `classes`, so nothing renders unqualified there). The corrected count is now the one recorded in `known-issues.md` bug #9, with the audit command included so it can be re-run rather than re-trusted.

**Why this belongs in the discovery log and not just the fix commit:** the process — verify a generated-SQL claim by generating the SQL, verify a "this only happens here" claim by re-running the search yourself — is the transferable part. The specific bug is one-time; the habit of not trusting a plausible technical claim (including this session's own earlier, incomplete read of the same code) without reproducing it is the thing worth being able to point to later.

## Session: 2026-08-10 — regression pass

Same orientation gap as Aug 8 (`discovery-log.md`, `decision-log.md`): no browser automation tool in this environment, so "click through all three roles" was substituted with the dev server actually running and driven over real HTTP with `curl` — real cookies, real mutations against `flexfit.db`, not `createTestCaller`'s hand-built context.

**Member (rahul.k), verified end to end:** `members.profile` baseline (10 credits) → `bookings.book` on a fresh class (credits 10→9, matches spec) → `reschedules.reschedule` to another session of the same class name (credits stayed at 9, carried forward rather than re-charged, matches spec exactly) → `bookings.cancel` on the rescheduled booking, ≥12h out (`refunded: true`, credits back to 10) → `corporateBookings.book` against the linked company's pool (succeeded, charged correctly). The full book → reschedule → cancel life cycle, plus the corporate path, confirmed live.

**Trainer (arjun), verified end to end:** `trainers.upcomingClasses` and `trainers.availability` both returned real rows matching seed assignment. `bookings.rosterFor` on one of his classes returned all 7 bookings including a `cancelled` one — live confirmation of the spec's "no status filtering" claim. `bookings.checkinCountFor` (0) → `bookings.markAttended` (`source: "kiosk"`) → `checkinCountFor` (1) → retried `markAttended` on the same booking, correctly rejected with the exact spec message ("Only confirmed bookings can be checked in.").

**Admin — only partially covered, stated plainly rather than implied as complete:** `auth.login`/`auth.me` (cookie session works), `admin.classUtilisation` (returned differentiated `booked` counts — `0, 4, 8, 0, 17` for HIIT/Spin/Power Vinyasa/Boxing/Advanced Spin — matching known-issues.md #9's CORRECT column exactly, confirming the fix is live, not just test-passing), `classes.list` (public, `spotsLeft`/`full` correct), and `payments.markPaid` → `payments.refund` → retried `markPaid` on the now-refunded payment (correctly rejected). **Not exercised this pass:** `classes.create`/`update`/`cancel`, any `admin-companies` action, `notifications.broadcast`, `members.search`/`setRole`/`setActive`. Those remain verified only by the characterization suite, not by a live HTTP call.

**A live discrepancy worth recording, not a bug — expected from the fixtures used:** `classes.list` showed `Advanced Spin` at `booked: 0` while `classUtilisation` showed `booked: 17` for the same class. Not a contradiction: it's the documented status-set difference (six-site table, site 6) — `classUtilisation` counts `booked` **and** `attended`, `classes.list` counts `booked` only — showing up naturally because that class had already run and its seed bookings were mostly `attended`.

**What this does and doesn't prove:** confirms the server-side behavior — the actual subject of this refactor's no-behavior-change constraint — end to end over the real wire format, for member and trainer fully and admin partially. Does **not** confirm the React UI renders any of this correctly; that needs an actual browser, unavailable in this environment. Judged low-risk rather than skipped silently: zero files under `src/app/` or `src/components/` were touched anywhere in this refactor (`architecture-decisions.md`'s Status section), so there's no frontend change for a UI walkthrough to have caught that this pass couldn't.

**Database state:** every call above mutated the real `flexfit.db`, not a throwaway test db — real credit deductions, a real reschedule, a real payment refund. `flexfit.db` is gitignored and untracked, so none of this reached the repo. `pnpm db:reset` has since been run (dev server stopped by hand first) and verified directly against the reseeded file, not just by trusting the reset command's exit code: all seven seed counts match (16 users, 6 plans, 12 memberships, 96 classes, 791 bookings, 96 checkins, 5 notifications), rahul's credits are back to 10, the two test bookings this pass created are gone, the booking marked `attended` during the trainer check is back to `booked`, the payment marked paid-then-refunded is back to `pending`, and `corporate_bookings` is back to empty. Clean.
