# Coverage matrix

Every claim in `behavior-spec.md` mapped to the test that proves it. As of Aug 9 work, all four priority routers (`bookings`, `corporate-bookings`, `reschedules`, `payments`) are covered — 64 tests, all green against the untouched routers (`pnpm test`, confirmed stable across repeated runs). This is what turns "I preserved behavior" from a claim into a demonstration, and closes the Aug 9 checkpoint the working brief requires before any extraction begins.

70 tests as of Aug 10: the 64 above, plus `admin.test.ts` (2 tests, added with the bug #9 fix) and `classes.test.ts` (4 tests, added to back known-issues.md #10 with the same red/green proof the other findings have — see the `classes.cancel` section below).

## `bookings`

| Spec claim | Test |
|---|---|
| `book` charges credits, confirms seat when room exists | `bookings.test.ts` › `book` › "charges credits and confirms the seat when there's room" |
| `book` skips decrement for unlimited (`>=999`) membership | `bookings.test.ts` › `book` › "does not decrement credits for an unlimited (>=999) membership" |
| `book` waitlists at capacity with `creditsUsed: 0`, no deduction | `bookings.test.ts` › `book` › "waitlists with zero credits charged once the class is at capacity" |
| `book` rejects duplicate active booking → `CONFLICT` | `bookings.test.ts` › `book` › "rejects a second active booking for the same class" |
| `book` rejects with no active membership → `FORBIDDEN` | `bookings.test.ts` › `book` › "rejects booking without an active membership" |
| `book` rejects insufficient credits → `FORBIDDEN` | `bookings.test.ts` › `book` › "rejects booking with insufficient (non-unlimited) credits" |
| `book` rejects cancelled class → `BAD_REQUEST` | `bookings.test.ts` › `book` › "rejects booking a cancelled class" |
| `book` rejects started class → `BAD_REQUEST` | `bookings.test.ts` › `book` › "rejects booking a class that has already started" |
| `book` rejects nonexistent class → `NOT_FOUND` | `bookings.test.ts` › `book` › "rejects booking a nonexistent class" |
| `cancel` refunds credits when `hoursUntil >= 12` | `bookings.test.ts` › `cancel` › "refunds credits when cancelling >= 12h before class start" |
| `cancel` withholds refund when `hoursUntil < 12` | `bookings.test.ts` › `cancel` › "does not refund credits when cancelling < 12h before class start" |
| `cancel` boundary: exactly 12h is refundable (inclusive) | `bookings.test.ts` › `cancel` › "treats exactly 12h remaining as refundable (boundary is inclusive)" |
| `cancel` promotes longest-waiting waitlisted booking | `bookings.test.ts` › `cancel` › "promotes the longest-waiting waitlisted booking when a booked seat frees up" |
| Bug #1 (individual half): promotion decrements credits unconditionally via `Math.max(0, …)` | `bookings.test.ts` › `cancel` › "promotes a waitlisted member for free even with zero credits (known-issues.md #1)" |
| `cancel` permits staff to cancel others' bookings | `bookings.test.ts` › `cancel` › "allows staff to cancel another member's booking" |
| `cancel` rejects non-owner/non-staff → `FORBIDDEN` | `bookings.test.ts` › `cancel` › "rejects cancellation by a non-owner, non-staff member" |
| `cancel` rejects already-inactive booking → `BAD_REQUEST` | `bookings.test.ts` › `cancel` › "rejects cancelling a booking that is already cancelled" |
| `markAttended` confirms → `attended`, records source | `bookings.test.ts` › `markAttended` › "checks in a booked member and records the checkin source" |
| `markAttended` rejects non-`booked` status | `bookings.test.ts` › `markAttended` › "rejects checking in a booking that isn't confirmed" |
| `markAttended` is staff-only | `bookings.test.ts` › `markAttended` › "rejects markAttended from a non-staff member" |
| `waitlisted` position is 1-indexed, ordered by `bookedAt` | `bookings.test.ts` › `waitlisted` › "reports 1-indexed queue position ordered by booking time" |
| Bug #8: same-second bookings tie at position 1 | `bookings.test.ts` › `waitlisted` › "gives every booking in the same wall-clock second the same position" |

| `mine` filters past bookings by default, includes them with `includePast: true` | `bookings.test.ts` › `mine` › "filters out past bookings by default but includes them with includePast: true" |
| `checkinCountFor` only counts individual check-ins (mirror of bug #5, seen from this side) | `bookings.test.ts` › `checkinCountFor` › "only counts individual checkins…" |

**Consciously not covered:** `rosterFor`, `upcomingForMember`. Both are a `select` + `join` + `where` with no conditional branches, no error paths beyond the existing staff-only guard (already characterized via the identically-shaped `markAttended` staff-only test), and no business rule to characterize — a test here would assert "the ORM returns the rows the ORM was asked for," which isn't a claim this refactor risks breaking. Revisit if either gains logic before the extraction lands.

## `corporateBookings`

| Spec claim | Test |
|---|---|
| `book` charges company pool, confirms seat | `corporate-bookings.test.ts` › `book` › "charges the company credit pool and confirms the seat when there's room" |
| `book` rejects member with no company link → `FORBIDDEN` | `corporate-bookings.test.ts` › `book` › "rejects a member not linked to any active company" |
| `book` rejects insufficient pool balance → `FORBIDDEN` | `corporate-bookings.test.ts` › `book` › "rejects when the company pool can't cover the class cost" |
| `book` treats an inactive company as "not linked" | `corporate-bookings.test.ts` › `book` › "ignores an active company link when the company itself is inactive" |
| `book` waitlists once `corporateBookings` alone hit capacity | `corporate-bookings.test.ts` › `book` › "waitlists once corporateBookings alone reach capacity, independent of individual bookings" |
| **Split-brain finding**: individual + corporate capacity counted independently | `corporate-bookings.test.ts` › `book` › "split-brain: individual and corporate bookings each fill capacity independently…" |
| `cancel` refunds pool at `hoursUntil >= 24` | `corporate-bookings.test.ts` › `cancel` › "refunds the pool when cancelling >= 24h before class start" |
| `cancel` withholds refund at `hoursUntil < 24` (window is 2× individual) | `corporate-bookings.test.ts` › `cancel` › "does not refund the pool when cancelling < 24h before class start" |
| Bug #1 (corporate half): promotion always happens, ledger deduction is conditional and can be skipped | `corporate-bookings.test.ts` › `cancel` › "promotes a waitlisted corporate booking even when the pool can't afford it…" |
| Bug #5: `markAttended` inserts `bookingId: null`, ignores `source` input | `corporate-bookings.test.ts` › `markAttended` › "records a checkin with bookingId null and ignores the source input…" |

**Consciously not covered:** `mine`, `rosterFor` — same reasoning as the individual-side equivalents above (plain projections, no branching logic).

## `reschedules`

| Spec claim | Test |
|---|---|
| Happy path: moves booking, carries credits, cancels original, records history | `reschedules.test.ts` › "reschedule — happy path" › "moves the booking, carries credits forward, cancels the original, records history" |
| Waitlists when target is full | `reschedules.test.ts` › "reschedule — happy path" › "waitlists the new booking when the target class is full" |
| `reschedule` and `validateReschedule` agree on every failure reason (10 scenarios) | `reschedules.test.ts` › "reschedule / validateReschedule agreement" — parametrized, one `it` per scenario: not found, not owner, inactive booking, inside 4h window, target not found, target different name, target same class, target started, target cancelled, duplicate active booking on target |
| Bug #2: `reschedule` never promotes the waitlist on a vacated `booked` seat | `reschedules.test.ts` › "documented bugs" › "#2 — reschedule never promotes the waitlist…" |
| Bug #3: rescheduling a waitlisted booking produces a free `booked` seat | `reschedules.test.ts` › "documented bugs" › "#3 — rescheduling a waitlisted booking produces a free booked seat" |
| Bug #4: `reschedule` ignores membership status entirely | `reschedules.test.ts` › "documented bugs" › "#4 — reschedule succeeds with no active membership…" |

| `reschedule` boundary: exactly 4h remaining is reschedulable (inclusive) | `reschedules.test.ts` › "reschedule — happy path" › "treats exactly 4h remaining as reschedulable…" |

No corporate path exists to test here (confirmed absent — see `behavior-spec.md`, not a gap in coverage).

## `payments`

| Spec claim | Test |
|---|---|
| `mine` returns only the caller's payments, newest first, with plan name denormalized | `payments.test.ts` › `mine` › "returns the caller's own payments…" |
| `mine` never returns another member's payments | `payments.test.ts` › `mine` › "does not return another member's payments" |
| `all` is admin-only | `payments.test.ts` › `all` › "is admin-only" |
| `all` lists across all members, respects `limit` | `payments.test.ts` › `all` › "lists payments across all members for admin, respecting the limit" |
| `markPaid` accepts pending → paid | `payments.test.ts` › `markPaid` › "marks a pending payment as paid" |
| `markPaid` rejects `refunded` → `BAD_REQUEST` | `payments.test.ts` › `markPaid` › "rejects marking a refunded payment as paid" |
| `markPaid` rejects nonexistent → `NOT_FOUND` | `payments.test.ts` › `markPaid` › "rejects a nonexistent payment" |
| `refund` sets `refunded`, cancels linked membership | `payments.test.ts` › `refund` › "refunds a paid payment and cancels the linked membership" |
| `refund` with no `membershipId` touches no membership | `payments.test.ts` › `refund` › "refunds a paid payment with no membershipId…" |
| `refund` rejects non-`paid` status (`pending`, `refunded`) → `BAD_REQUEST` | `payments.test.ts` › `refund` › "rejects refunding a payment that isn't paid (pending)" and "…an already-refunded payment" |
| `refund` is admin-only | `payments.test.ts` › `refund` › "is admin-only" |

## `admin.classUtilisation`, `classes.list`

| Spec claim | Test |
|---|---|
| Bug #9 (fixed): `classUtilisation` reports each class's own booked count, not a value shared across every row | `admin.test.ts` › `classUtilisation` › "reports each class's own booked count, not a value shared across every row…" |
| `classUtilisation` correctly aggregates and limits distinct classes, not pre-`groupBy` join rows | `admin.test.ts` › `classUtilisation` › "returns exactly `limit` classes, correctly aggregated, even when one has many bookings" |

Bug #9 is fixed as of this commit — the test originally pinned the wrong values (see `known-issues.md` #9 and `decision-log.md` for the before/after and the fix candidates tested) and was rewritten in the same commit as the fix to assert the correct, differentiated counts instead; the diff of that rewrite is itself part of the evidence the fix was deliberate. `classes.list`'s `spotsLeft`/`full` were confirmed correct via the same `.toSQL()` audit that found the bug (not through a dedicated test) — its query shape includes a join, which is exactly why it was unaffected; see `known-issues.md` bug #9 for the full comparison.

## `classes.cancel`

| Spec claim | Test |
|---|---|
| Bug #10.1: cancelling a class does not refund credits for members who had booked it | `classes.test.ts` › "documented bugs" › "#10.1 — cancelling a class does not refund credits…" |
| Bug #10.2: waitlisted bookings are untouched, left pointing at the now-cancelled class | `classes.test.ts` › "documented bugs" › "#10.2 — cancelling a class leaves waitlisted bookings untouched…" |
| Bug #10.3: `corporateBookings` is never touched — seat and pool charge remain in effect | `classes.test.ts` › "documented bugs" › "#10.3 — cancelling a class never touches corporateBookings…" |
| Bug #10.4: no notification is sent to any affected member | `classes.test.ts` › "documented bugs" › "#10.4 — cancelling a class sends no notification…" |

Added specifically because #10 was flagged as the most consequential finding in `known-issues.md`; #11–#14 remain documentation-only, verified against source but without dedicated tests, consistent with the working brief gating further router test coverage (`classes`, `plans`, `trainers`, `admin-companies`) behind Tier 2. All four ran green against the unmodified `classes.cancel`, and the full 70-test suite was re-run afterward to confirm no interference with the existing bug #1-9 tests — each test file provisions its own isolated temp SQLite database (`test/helpers/db.ts`), so there is no shared state between files to begin with.
