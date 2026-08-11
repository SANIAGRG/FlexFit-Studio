# AI usage log

Honest running log, per session. Not scored per the brief, but the brief is explicit that disclosure quality is itself evidence for "do I understand what's in my repo" — so this includes what went wrong and was self-corrected, not just a clean summary.

---

## Session: 2026-08-09 (Aug 8 work)

**Tool:** Claude Code (Sonnet 5), working directly in this repo.

**What it did, in order:**

1. Cloned the repo, ran `pnpm install`, `pnpm db:push`, `pnpm db:seed`, started `pnpm dev`.
2. Read `Claude code handover.md` in full and treated its findings as claims to verify, not facts to restate — re-derived each one from source (schema, all routers, seed data) before writing anything down. All of the brief's specific claims (six occupancy sites, the reschedule duplication, the constants, all seven bugs) checked out against source; none needed correction. One clarification made beyond the brief: bug #6 (`waitlist_promotion`) is broader than "the type is unused" — the promotion code path sends *no* notification of any kind, confirmed by reading `bookings.ts` `cancel` directly rather than assuming from the type name.
3. **Orientation gap, disclosed rather than papered over:** this environment has no browser automation tool. "Log in as each role and click through every flow" was substituted with (a) reading every router end to end and (b) driving the real running dev server over `curl` — login, session cookie, protected query — to confirm the server-side path actually works on seeded data. Recorded as a real limitation in `discovery-log.md`, not silently treated as equivalent to a UI walkthrough.
4. Built test infrastructure: `vitest.config.ts` (path alias), a one-line change to `drizzle.config.ts` to read `DB_FILE` from the environment (mirroring the pattern already in `src/db/index.ts`, so tests can point schema-push at a throwaway file), `test/helpers/db.ts` (provisions a temp SQLite file per test file via `drizzle-kit push`), `test/helpers/caller.ts` (`createCaller` wrapper), `test/helpers/fixtures.ts` (typed builders for users/memberships/classes/companies).
5. Wrote `behavior-spec.md` and characterization tests together, router by router, in the brief's priority order: `bookings` (22 tests) → `corporate-bookings` (10 tests) → `reschedules` (15 tests, including a 10-scenario parametrized test asserting `reschedule` and `validateReschedule` agree on every failure reason). All 49 tests pass against the unmodified routers. `payments` not started this session.
6. Wrote `known-issues.md` (the seven bugs from the brief, each with a verified repro), `architecture-decisions.md` (first draft — the individual-vs-corporate call, and why), `decision-log.md`, `coverage-matrix.md`.

**What was gotten wrong and self-corrected, in real time, before being presented as done:**

- **Windows temp-file cleanup.** The first version of `test/helpers/db.ts` called `client.close()` then immediately `rmSync` on the temp directory; on Windows the SQLite file handle isn't always released the instant `close()` returns, so the very first test run failed on teardown with `EPERM`, even though both actual test assertions had passed. Fixed with a short retry loop. Caught by running the test, not assumed to work.
- **Fake timers don't touch the database's own clock.** The first version of the waitlist-position test used `vi.useFakeTimers` and advanced fake time between bookings, expecting `bookedAt` (populated by SQLite's own `CURRENT_TIMESTAMP`, evaluated inside the engine) to move with it. It didn't — the test failed with all positions reporting `1`. Initially looked like a router bug; re-reading `schema.ts` clarified that `CURRENT_TIMESTAMP` is a SQL-side default, not a JS `Date` call, so no amount of faking the Node clock reaches it. Rewrote that test to use a real wall-clock `setTimeout`-based wait instead. The *failing* run itself turned out to be informative rather than just a mistake to fix and discard — it's now `known-issues.md` bug #8 (same-second waitlist joins tie at position 1), found by the test behaving unexpectedly, not predicted in advance.
- **Wrong test setup for the corporate promotion-affordability test.** First draft tried to reach "waitlisted, company pool insufficient" by calling `corporateBookings.book` twice against an under-funded pool — but `book`'s own credit check rejects a second booking attempt outright before it can even reach a waitlisted state (`FORBIDDEN`, "Your company does not have enough credits."), so the test failed with that error instead of exercising the promotion path at all. Corrected by inserting the waitlisted row directly (bypassing the router, matching the technique already used for the equivalent individual-side test) and by moving the cancellation inside the 24h no-refund window so the pool balance is actually still short by the time promotion runs — the first attempt at that scenario used a >24h cancellation, which refunds the pool to exactly the amount needed and would have passed without actually proving anything about the under-funded case.

- **Flaky test found by running the suite twice, not just once.** The bug #8 tie-position test (three sequential `bookings.book` calls, asserting all three land in the same wall-clock second) passed in isolation but failed intermittently in the full `pnpm test` run, because other test files running in parallel compete for CPU and can push three sequential DB round-trips across a second boundary. Root cause: the test was asserting on timing luck, not on the tie behavior itself. Fixed by inserting the three waitlisted rows directly with an identical explicit `bookedAt`, making the tie deterministic instead of hoping the machine is fast enough. Caught by re-running `pnpm test` (not just the single new file) after an unrelated typecheck fix — worth remembering that a green single-file run is not sufficient evidence a test is non-flaky.

**What was not attempted this session, and why:** `payments` characterization tests (priority order puts it last; ran out of session time after depth on the first three), full UI click-through (see orientation gap above), any actual refactoring (per the brief, correctly sequenced after Aug 9's "all green against unrefactored code" checkpoint, not before).

---

## Session: 2026-08-09 (Aug 9 work)

**Tool:** Claude Code (Sonnet 5), continuing directly in this repo.

**What it did, in order:**

1. Closed out the Aug 9 checkpoint: wrote `payments` behavior spec + 12 characterization tests (the router skipped on Aug 8), plus filled two deliberately-scoped coverage gaps flagged in `coverage-matrix.md` (`bookings.mine` past/future filtering, `bookings.checkinCountFor`) and a reschedule 4h boundary test. Explicitly did **not** add tests for `rosterFor`/`upcomingForMember`/corporate `mine`/`rosterFor` — plain projections with no branching logic to characterize — and said so in `coverage-matrix.md` rather than leaving the gap unexplained.
2. Confirmed the Aug 9 gate: the suite stood at 64 tests at that point in the session, `pnpm test` run twice back to back (stability check, not just a single green run) and `npx tsc --noEmit` clean, all against the *unrefactored* routers.
3. Refactored in the order the brief specified — easiest/lowest-risk first — running the full suite and a typecheck after every single step, not batched at the end: `hoursUntil` → the four constants → the reschedule validation ladder → capacity counting. All 64 tests that existed at that point stayed green after each step with zero test edits required (the tests characterize router *output*, not implementation, so a correct extraction shouldn't need to touch them — and didn't; the suite later grew to 70 by the Aug 10/11 session — current count in `coverage-matrix.md`).
4. Mid-extraction, found the capacity step didn't fit the plan as originally sketched in Aug 8's `architecture-decisions.md`: two of the six occupancy sites (`classes.list`, `admin.classUtilisation`) are correlated subqueries inside one bulk `select`, not standalone per-class count calls like the other three. Revised the plan rather than force a mismatched abstraction — extracted the three sites that were genuine duplication, left the two structurally-different ones inline, and rewrote the relevant section of `architecture-decisions.md` to describe what was actually built instead of layering a correction on top of the stale draft.
5. Removed a piece of dead code (`reschedules.ts`'s unused `activeMembershipFor` copy) as a side effect of rewriting that file around the extracted validation ladder — deliberate, not incidental; reasoned through in `decision-log.md` and reflected in `known-issues.md` bug #4's writeup, since that function was the literal evidence cited for the bug and no longer exists in source.

**What was gotten wrong and self-corrected:** nothing required a second pass this session — each extraction step was typechecked and full-suite-tested before moving to the next, which is what caught problems immediately rather than after they'd compounded (there weren't any that reached a red test, unlike Aug 8). The closest thing to a correction was recognizing mid-step-4 that the original `capacity.ts` plan didn't fit reality and needs revising in the docs — not a mistake in code, but a plan that turned out to be wrong on contact with the actual query shapes, corrected before landing rather than after.

**What was not attempted this session:** Tier 2 work (typed error catalog, admin/trainers/classes characterization tests, the `admin/companies/[id]` and `trainer/schedule` data-fetching duplication) — explicitly gated behind Tier 1 completion and the brief says to ask before starting any of it.

---

## Session: 2026-08-10

**Tool:** Claude Code (Sonnet 5), continuing directly in this repo.

**What it did, in order:**

1. Verified six findings handed over as claims, not facts — read `classes.ts`, `plans.ts`, `payments.ts`, `trainers.ts`, `admin-companies.ts`, and `seed.ts` directly (grepping for call sites, not trusting descriptions) before writing anything. All six checked out exactly as described, including the more subtle ones: bug #14's guard genuinely exists but is scoped to `(userId, companyId)` rather than `userId` alone, and the notification-type finding required cross-referencing `seed.ts` against every router's `insert(notifications)` call site to confirm only `announcement` is ever produced by live code.
2. Expanded `known-issues.md` #6 (three of four notification types are dead, disguised by seed data) and added five new entries, #10-#14, plus a systemic paragraph connecting #1/#2/#6 into one waitlist-reliability story. Added a section to `architecture-decisions.md` explaining why transactions were never added — the reasoning being that adding them is itself a behavior change the characterization suite structurally can't verify.
3. **Sizing correction, caught by explicit feedback, not self-caught.** First draft of #11-#14 ran 10-15 lines each against an explicit "four or five lines each" instruction. Trimmed all four to tight `Where`/`Repro`/`Decision` paragraphs, keeping the verified line numbers and mechanism, cutting the restated commentary.
4. **Evidence-strength gap, flagged proactively rather than left implicit.** Bugs #1-#9 each have a passing characterization test; #10-#14 were verified against source but had no test, a real asymmetry a reviewer could notice. Named it explicitly rather than let the new entries quietly carry weaker evidence than the rest of the document.
5. Added `test/classes.test.ts` (4 characterization tests) for #10 only — the one flagged most consequential — leaving #11-#14 documentation-only per Tier 2 gating. Verified isolation before treating it as safe, not just after: each test file provisions its own temp SQLite db (structural isolation), confirmed by running `classes.test.ts` alone (4/4 green, no dependency on other files) and with `--sequence.shuffle` (order-independence within the file, since no fixture is shared across its four `it` blocks). Full suite re-run after: 70/70.

**What was gotten wrong and self-corrected:** first version of the #10.2 test (waitlisted-booking-untouched) booked the waitlisted member without giving them a membership first — `bookings.book` requires an active membership before it will even waitlist someone, so the test failed on setup with `FORBIDDEN`, not on the actual assertion. Caught by the first test run, not review; fixed by adding the missing `makeMembership` call, re-ran green.

**What was not attempted this session:** tests for #11-#14 (Tier 2, not asked for beyond #10), and the Aug 10 regression walk across all three roles (in progress, paused for this discovery pass).
