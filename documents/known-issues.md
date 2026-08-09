# Known issues

Pre-existing bugs found while reading the routers for the refactor. Each entry has exact repro steps so a reader can verify the finding in a minute without re-deriving it. Default is to document, not fix, per the working brief — **bug #9 is the one deliberate exception**, fixed in its own commit with the reasoning stated at that entry.

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

**Where:** originally `reschedules.ts`, where a dead `activeMembershipFor` helper (lines 22-39, byte-identical to the live one in `bookings.ts`) was defined and never called — the direct evidence this check was intended and dropped, not merely never considered. As of the Aug 9 `reschedule-rules.ts` extraction, that dead function no longer exists in source (removed as genuinely unreachable code during the rewrite of `reschedules.ts` — dead code has no runtime behavior, so removing it isn't a behavior change; see `decision-log.md`). The underlying bug is unchanged and still proven by test: `evaluateReschedule` in `src/server/booking/reschedule-rules.ts` still contains no membership check anywhere in its ladder.

Neither `reschedule` nor `validateReschedule` verifies the member has an active, non-expired membership before letting them move to a different class. A member whose membership expired since their original booking can still reschedule freely.

**Repro:** book a class while membership is active, then let the membership expire (or set `status: "expired"` / push `endDate` into the past), then call `reschedules.reschedule` with that booking. It succeeds. Reproduced in `test/reschedules.test.ts` › "documented bugs" › "#4 — reschedule succeeds with no active membership."

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

---

### 9. `admin.classUtilisation` reports the same booked count for every class — the report is non-functional

**Found via characterization testing, not in the original brief's list. This is the exception to "document by default" — see Decision below.**

**Where:** `admin.ts` `classUtilisation` (~line 63-87). The `booked` column is a raw `sql` template subquery:

```sql
select "id", "name", (
  select count(*) from "bookings"
  where "class_id" = "id"
    and "status" in ('booked','attended')
) as "booked" from "classes" where "classes"."cancelled" = ?
```

(Verified with Drizzle's own `.toSQL()` against the exact query shape in source, not reconstructed by hand.) Both `"class_id"` and `"id"` in the `WHERE` clause are unqualified. Drizzle qualifies column references (`"classes"."id"`) when the outer query has more than one table registered in its builder state (e.g. a join is present), and renders them bare when only one table is — here, `classes` alone. The subquery's own `FROM` is `bookings`, which is the innermost scope, so the bare `"id"` resolves to `bookings.id`, not the intended `classes.id`. The predicate is literally `bookings.class_id = bookings.id` — a condition with no dependency on the outer class row at all, so the subquery returns one fixed value, repeated for every row in the result set.

**Contrast — the sibling query that looks identical but isn't buggy:** `classes.ts` `list` (~line 24-45) has the same raw-subquery shape but its outer query has a `leftJoin(users, ...)`, so Drizzle renders everything qualified:

```sql
select "classes"."id", ... , (
  select count(*) from "bookings"
  where "bookings"."class_id" = "classes"."id"
    and "bookings"."status" = 'booked'
) as "booked" from "classes" left join "users" on "classes"."trainer_id" = "users"."id" ...
```

`spotsLeft`/`full` on the member-facing schedule page are correct. Only the admin-facing report is affected.

**Symptom, confirmed against the real seeded database** (`flexfit.db`, via a script run outside the test suite comparing the buggy query to a properly-correlated one row by row):

```
BUGGY (current code):        CORRECT (properly correlated, same data):
HIIT Circuit    booked=1     HIIT Circuit    booked=0
Spin 45         booked=1     Spin 45         booked=4
Power Vinyasa   booked=1     Power Vinyasa   booked=8
Boxing Fund.    booked=1     Boxing Fund.    booked=0
Advanced Spin   booked=1     Advanced Spin   booked=17
Sunrise Yoga    booked=1     Sunrise Yoga    booked=4
```

Every class currently reports `booked: 1` regardless of its actual booking count. **Observable effect: the admin utilisation report shows an identical booked count and utilisation percentage for every class**, all the time, on real data — not an edge case.

**Repro:** reproduced deterministically in `test/admin.test.ts` — two classes, one with 3 real `booked` bookings and one with none, both report the same `booked` value, which is also not the real count of 3 for the class that has bookings.

**Blast radius, audited repo-wide, not assumed:** grepped every router for raw `sql` template usage containing a nested `SELECT`/`select` (`grep -rn "SELECT|select" src/server/routers -i`, cross-checked against a plain-text scan for `sql\`(`). Found **seven** such nested-subquery sites, not two:

- `admin.ts:73` (`classUtilisation`) — **buggy**, single-table outer scope, confirmed above.
- `classes.ts:37` (`list`) — safe, outer query has a join, confirmed via `.toSQL()`.
- `reschedules.ts:70,74,78,82,86` (`history`, five subqueries denormalizing from/to class name/time/room) — safe, confirmed via `.toSQL()`: the outer query already joins `classes` (`innerJoin(classes, eq(reschedules.fromClassId, classes.id))`), so every reference renders qualified (`"classes"."id" = "reschedules"."from_class_id"`), and even where it wouldn't, the specific column names involved (`from_class_id`, `to_class_id`) don't collide with any column in `classes`, so there's no name that could shadow-bind incorrectly the way `bookings.id`/`classes.id` did.

So the actual finding is narrower and more precise than "raw subqueries are risky here": the bug requires *both* an unqualified render *and* a same-named column colliding across the two tables involved. Only one site has both.

**Decision: fix it. This is the one exception to "document by default" among the nine findings in this file.**

The other eight stay documented-only because "correct" is a product decision with no obviously right answer — should an unfunded waitlist promotion fail, or go through at negative credits? Genuinely ambiguous, not this refactor's call to make. This one is different: a correlated subquery is correlated by definition; nobody intended `bookings.class_id = bookings.id`. The intended behavior — count bookings for *this* class — is written plainly in the source (`${bookings.classId} = ${classes.id}` in the template), and the framework silently discarded that intent at render time. Restoring it invents no new rule; it makes the code do what it already, visibly, was trying to do. It is also a data-correctness defect in a report a staff member could make real decisions from, and the blast radius is now precisely measured at one call site.

**The tension, named explicitly rather than glossed over:** fixing this changes `admin.classUtilisation`'s observable output — every `booked` and `utilisation` value in its response changes for every class. "Same outputs" is the headline constraint of this entire project, and this is a deliberate, acknowledged exception to it, not an oversight. The alternative — leaving a report that shows every class as identically utilised, forever, as "preserved behavior" — would be worse than the inconsistency of one documented exception: it isn't behavior anyone relies on or could rely on (a report where every row is identical carries no information), and preserving it as-is would mean knowingly shipping a broken report to protect a rule whose purpose is protecting *working* behavior. See `architecture-decisions.md` for the fix itself and the options considered.
