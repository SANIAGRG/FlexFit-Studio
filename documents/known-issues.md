# Known issues

Pre-existing bugs found while reading the routers for the refactor. None of these are fixed — per the working brief, the default is to document, not fix, unless explicitly asked. Each entry has exact repro steps so a reader can verify the finding in a minute without re-deriving it.

---

### 1. Waitlist promotion is asymmetric between individual and corporate bookings

**Where:** `bookings.ts` `cancel` (~line 239-249) vs. `corporate-bookings.ts` `cancel` (~line 244-260).

Individual: when promoting the next waitlisted member, credits are decremented with `Math.max(0, ms.creditsRemaining - row.cls.creditCost)` — unconditionally. A member with 0 credits remaining gets promoted to a booked spot for free (no error, no skip).

Corporate: the promotion itself (`status: "booked"`, `creditsUsed: row.cls.creditCost`) always happens, but the credit-pool deduction only happens `if (company.creditPoolBalance >= row.cls.creditCost)`. So an under-funded company's employee is promoted and the booking is recorded as costing credits — but the pool is never actually charged.

Both paths always promote regardless of affordability; they disagree only on whether the ledger is updated to match. Two different wrong answers to the same underlying question ("what happens when you promote someone who can't afford it").

**Repro (individual):** seed a member with `creditsRemaining: 0` and an active membership, put them on the waitlist for a class where the booked count is at capacity, then cancel a `booked` spot on that class. The waitlisted member is promoted to `booked` and their `creditsRemaining` stays at 0 (not negative, not blocked).

---

### 2. `reschedule` never promotes the waitlist when vacating a `booked` seat

**Where:** `reschedules.ts` `reschedule` (whole mutation) vs. `bookings.ts` `cancel` (~line 213-252).

`cancel` explicitly promotes the longest-waiting waitlisted booking when a `booked` seat is freed. `reschedule` cancels the original booking (moving to `status: "cancelled"`) but has no equivalent promotion step.

**Repro:** book a class to capacity, put one more member on the waitlist, then have a `booked` member reschedule out of that class to a different class. The vacated seat stays empty; the waitlisted member is never promoted, even though cancelling (instead of rescheduling) out of the same seat would have promoted them.

---

### 3. Rescheduling a waitlisted booking is free

**Where:** `reschedules.ts` `reschedule`, line ~189 (`creditsUsed: originalBooking.creditsUsed`).

A waitlisted booking has `creditsUsed: 0` (set at creation in `bookings.book`, since waitlisted members aren't charged). `reschedule` carries `creditsUsed` forward unchanged. If the target class has room, the new booking is created as `status: "booked"` with `creditsUsed: 0` — a confirmed spot that cost nothing.

**Repro:** get waitlisted for a full class (`creditsUsed` will be 0 on that booking), then reschedule to a different, non-full class of the same name. The new booking is `booked` with `creditsUsed: 0`.

---

### 4. `reschedule` never checks membership status

**Where:** `reschedules.ts`, `activeMembershipFor` is defined (lines 22-39) and never called.

Neither `reschedule` nor `validateReschedule` verifies the member has an active, non-expired membership before letting them move to a different class. A member whose membership expired since their original booking can still reschedule freely. The dead `activeMembershipFor` function is the direct evidence this check was intended and dropped, not merely never considered.

**Repro:** book a class while membership is active, then let the membership expire (or set `status: "expired"` / push `endDate` into the past), then call `reschedules.reschedule` with that booking. It succeeds.

---

### 5. Corporate check-ins are unrecorded / undercounted

**Where:** `corporate-bookings.ts` `markAttended` (lines ~291-299) vs. `bookings.ts` `checkinCountFor` (lines ~347-357).

`corporateBookings.markAttended` inserts a `checkins` row with `bookingId: null` — it ignores the `bookingId` of the corporate booking being checked in (there's no FK from `checkins` to `corporateBookings`, only to `bookings`) — and also ignores its own `source` input entirely (the insert doesn't reference `input.source` at all, so `source` always defaults to `"front_desk"` regardless of what was passed).

Separately, `bookingsRouter.checkinCountFor` does `innerJoin(bookings, eq(checkins.bookingId, bookings.id))`. Since corporate check-ins have `bookingId: null`, that inner join drops them — corporate attendees never appear in any check-in count anywhere in the app.

**Repro:** mark a corporate booking attended via `corporateBookings.markAttended` with `source: "kiosk"`, then call `bookings.checkinCountFor` for that class. The count is unaffected by the corporate check-in; inspecting the inserted `checkins` row shows `bookingId: null` and `source: "front_desk"` regardless of what was passed in.

---

### 6. `waitlist_promotion` notifications are never sent

**Where:** schema (`schema.ts:134`) and seed (`seed.ts:323`) both reference the `waitlist_promotion` notification type; the actual promotion code (`bookings.ts` `cancel`, ~line 213-252, and the corporate equivalent) never inserts into `notifications` at all.

This is broader than "the type is unused" — promoting a waitlisted member to a booked spot currently sends that member no notification of any kind, through any channel. The only place `waitlist_promotion` appears outside the schema enum is one hand-written sample row in seed data, which does not correspond to any code path that would actually produce it.

**Repro:** trigger a waitlist promotion (see bug #1's repro), then check `notifications` for the promoted user. No new row.

---

### 7. No transactions anywhere — read-then-write races

**Where:** every mutation in `bookings.ts`, `corporate-bookings.ts`, `reschedules.ts`, `payments.ts`.

All capacity checks, credit checks, and balance updates are separate `select` then `update`/`insert` calls with no surrounding transaction and no row locking. Two concurrent `bookings.book` calls for the last open seat can both read `count < capacity` before either writes, and both insert as `status: "booked"` — overbooking the class. Same shape of race applies to credit/balance deductions.

**Repro:** requires concurrent requests to demonstrate (two simultaneous `book` calls against a class with exactly one seat left); not practical to show with a single sequential trace, which is itself the point — this class of bug doesn't show up in manual click-through testing at all, only under load or via a deliberately interleaved test.

**Decision:** documented only, not fixed. Wrapping in transactions would change the concurrent-access behavior of the app, which is out of scope for a no-behavior-change refactor and is exactly the kind of change the working brief calls out as needing its own commit with reasoning, at minimum, and arguably needing product sign-off first (does overbooking-under-race even matter at this traffic level?).

---

### 8. Waitlist position ties when bookings land in the same wall-clock second

**Found via characterization testing, not in the original brief's list.**

**Where:** `bookings.ts` `waitlisted` (~line 384-393). `bookedAt` is populated by SQLite's `CURRENT_TIMESTAMP`, which has 1-second resolution. Queue `position` is computed as `1 + count of other waitlisted bookings for the same class with a strictly earlier bookedAt`. Two bookings created within the same second have equal `bookedAt`, and "equal" doesn't count as "earlier" — so both report the same position.

**Repro:** get three members waitlisted for the same full class in rapid succession (all within one second — realistic under any real burst of demand, e.g. a popular class going live). All three see `position: 1`, not `1`, `2`, `3`. Reproduced directly in `test/bookings.test.ts` (`gives every booking in the same wall-clock second the same position`); a second test in the same file confirms position ordering *does* work correctly once real time is allowed to advance between bookings, isolating the resolution limit as the specific cause rather than a broader logic error.

**Decision:** documented only. Fixing this would mean either a higher-resolution timestamp column or an explicit sequence/tiebreaker column — either is a schema change, which is out of scope for a behavior-preserving refactor and affects ordering semantics other code may implicitly depend on.
