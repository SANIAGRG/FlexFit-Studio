# Known issues

Pre-existing bugs found while reading the routers for the refactor. Each entry has exact repro steps so a reader can verify the finding in a minute without re-deriving it. Default is to document, not fix, per the working brief — **bug #9 is the one deliberate exception**, fixed in its own commit with the reasoning stated at that entry.

Discovery started with the four priority routers (`bookings`, `corporate-bookings`, `reschedules`, `payments`) and #1-#9 come from that pass. #10-#14 come from a second pass over the remaining routers (`classes`, `plans`, `trainers`, `admin-companies`) and payments' full blast radius, plus reading `seed.ts` directly against the routers rather than the routers alone — which is what surfaces #6's fuller scope below.

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

### 6. Three of four notification types are never inserted by the running app — only seeded

**Where:** `schema.ts:134` defines `notifications.type` as `enum: ["waitlist_promotion", "class_cancelled", "membership_expiring", "announcement"]`. Grepping every router for a `notifications` insert (`grep -rn "insert(notifications)" src/server/routers`) finds exactly **one** call site: `notifications.ts` `broadcast` (~lines 65-72), which always inserts `type: "announcement" as const` — hardcoded, not derived from any input or condition. No other router ever inserts a `notifications` row of any type — not `bookings.ts` `cancel`'s waitlist-promotion path, not `classes.ts` `cancel` (see bug #10, failure 4), nowhere.

So three of the four schema types — `waitlist_promotion`, `class_cancelled`, `membership_expiring` — are defined and never produced by any live code path. Only `announcement`, via the one admin broadcast action, is real.

**The seed disguise, and why it's the valuable half of this finding:** `seed.ts` (~lines 320-358) hand-inserts one sample row of each of the four types directly into `notifications`, including one `waitlist_promotion` and one `class_cancelled` row. A freshly seeded database therefore shows a populated, varied notification list for those seeded users — `notifications.list` and `.unreadCount` return real rows of all four types, because those read queries don't know or care how a row got there. Reading the routers alone (the first-pass discovery) suggested one narrow gap, waitlist promotions specifically. Reading `seed.ts` side by side with the routers is what surfaces the fuller picture: the notification feature *looks* fully wired in a freshly seeded demo, because the seed script performed, once, by hand, the exact insert the application code never performs on its own.

**Repro:** trigger a waitlist promotion (bug #1's repro) or a class cancellation with active bookings (bug #10, failure 4) — in both cases no `notifications` row is inserted for the affected member. Compare against `notifications.list` for a freshly seeded user, which already shows a `waitlist_promotion` row and a `class_cancelled` row — both predate any real event; they're seed fixtures, not evidence that the code path which should produce them ever ran.

**The systemic picture — read together with bugs #1 and #2:** these three findings aren't independent small gaps; they're one story about the waitlist feature specifically. A member gets promoted from the waitlist — possibly for free if they can't afford it, or without the ledger being charged on the corporate side (#1). If the seat was freed by a reschedule rather than a cancellation, the promotion may not happen at all (#2). Either way, the promoted member is never told (#6, this entry). Put together: a member can be silently promoted, charged credits, never notified, and never show up — wasting the exact seat the promotion was supposed to fill, which is the outcome the waitlist mechanism exists to prevent. No one of the three is catastrophic alone; together they describe a feature that doesn't reliably do what it's for.

**Decision:** documented only, same reasoning as #1 and #2 — what "correct" looks like here (fail the promotion outright when unaffordable? backfill a notification retroactively? auto-refund a corporate pool?) is a product decision, not one a behavior-preserving refactor should make unilaterally.

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

### 9. `admin.classUtilisation` reports the same booked count for every class — the report is non-functional — **FIXED**

**Found via characterization testing, not in the original brief's list. This is the exception to "document by default" — see Decision below. Fixed via `leftJoin` + `groupBy` (see the fix candidates below and `architecture-decisions.md`); the description below is left in the present tense as an accurate record of the bug that existed, not a claim about current behavior.**

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

**Fix candidates, tested against real seeded data before picking one — not chosen by reasoning about them in the abstract:**

1. **`sql.raw` explicit qualification.** Replace the template's `${classes.id}` reference with a raw literal `sql.raw('"classes"."id"')`, bypassing Drizzle's column-rendering logic entirely. Verified correct (`0, 4, 8, 0, 17, 4` against seeded data, matching a manually-correlated ground-truth query exactly). Smallest possible diff. **Rejected** despite working: a hardcoded raw string is exactly as invisible to a table rename, a type check, or a test as the original bug was — a `sql.raw` literal doesn't get flagged if `classes` is ever renamed, which is the same class of silent failure this bug already demonstrated is possible here.
2. **Alias the outer table** (`alias(classes, "c")`, reference `c.id` in the subquery). This was the more "obvious"-looking fix — aliasing forces an explicit name onto the table, so it looks like it should force qualification. **Tested and found not to work.** Generated SQL: `select "id", "name", (... where "class_id" = "id" ...) from "classes" "c"` — the subquery reference still renders bare `"id"`, still collides with `bookings.id`, values still identical across all rows. Aliasing changes the table's *name* in the outer scope but not Drizzle's "how many tables are registered" count that actually drives the qualification decision, so it does nothing to fix this. Recorded here specifically so the next person who reaches for this "obvious" fix doesn't have to rediscover that it doesn't work.
3. **Replace the correlated subquery with a `leftJoin` + `groupBy` aggregate.** `count(bookings.id)` over `classes.leftJoin(bookings, and(eq(bookings.classId, classes.id), inArray(bookings.status, [...])))`, grouped by `classes.id`. Verified correct against the same seeded data, including the zero-booking case (`HIIT Circuit`, `Boxing Fundamentals` both correctly return `0`, not `null` or a dropped row — `COUNT()` over a left join's null-padded row is `0` by SQL semantics). **Chosen.** No raw string anywhere; the whole query stays inside Drizzle's typed query builder, so a table rename would be caught at compile time instead of failing silently the way this bug did. It removes the mechanism that caused the bug (there's no longer a correlated subquery that could mis-qualify) rather than patching this one instance of it.

**Two additional things verified before committing to option 3, since they're exactly the kind of side effect that's easy to wave through:**

- **Row order.** The original query has no `ORDER BY` (a `.limit()` with implicit ordering), so row order was already unspecified per SQL semantics — but "unspecified" and "actually the same every time" are different claims, and only one of them is checkable. Ran both the buggy query and the `leftJoin`+`groupBy` candidate against the same seeded data four times each: both returned classes in the identical sequence (ascending `id`, `1..10`) on every run. Not adding an `ORDER BY` to "fix" this, per the reasoning that would itself be a new, undocumented behavior decision — the check was only to confirm the join+aggregate rewrite doesn't *change* an already-unordered result into a *differently* unordered one on real data.
- **`limit` semantics.** Confirmed `LIMIT` applies after `GROUP BY`, not before — `limit=5` against seeded data returns exactly 5 distinct classes, correctly including `Advanced Spin` (id 5, 17 real bookings) with its correct `booked: 17`, not corrupted or truncated by the 17 raw join rows that exist for that class before grouping collapses them.

**One more thing worth stating plainly rather than leaving for a reviewer to flag:** the fixed query selects `name`, `startsAt`, and `capacity` while grouping only by `classes.id`. SQLite permits this — unlike stricter engines, it doesn't require every selected column to be in the `GROUP BY` list or wrapped in an aggregate. It's correct here specifically because `id` is the primary key: each group has exactly one possible value for those columns (there's only one row per class), so there's no ambiguity for SQLite to resolve arbitrarily. This is a property of `id` being a primary key, not a lenient behavior being relied on to paper over something.

**Decision: fix it. This is the one exception to "document by default" among the fourteen findings in this file.**

The other eight stay documented-only because "correct" is a product decision with no obviously right answer — should an unfunded waitlist promotion fail, or go through at negative credits? Genuinely ambiguous, not this refactor's call to make. This one is different: a correlated subquery is correlated by definition; nobody intended `bookings.class_id = bookings.id`. The intended behavior — count bookings for *this* class — is written plainly in the source (`${bookings.classId} = ${classes.id}` in the template), and the framework silently discarded that intent at render time. Restoring it invents no new rule; it makes the code do what it already, visibly, was trying to do. It is also a data-correctness defect in a report a staff member could make real decisions from, and the blast radius is now precisely measured at one call site.

**The tension, named explicitly rather than glossed over:** fixing this changes `admin.classUtilisation`'s observable output — every `booked` and `utilisation` value in its response changes for every class. "Same outputs" is the headline constraint of this entire project, and this is a deliberate, acknowledged exception to it, not an oversight. The alternative — leaving a report that shows every class as identically utilised, forever, as "preserved behavior" — would be worse than the inconsistency of one documented exception: it isn't behavior anyone relies on or could rely on (a report where every row is identical carries no information), and preserving it as-is would mean knowingly shipping a broken report to protect a rule whose purpose is protecting *working* behavior. See `architecture-decisions.md` for the fix itself and the options considered.

---

### 10. `classes.cancel` doesn't actually cancel a class — it only marks it cancelled and drops confirmed individual bookings, leaving credits, waitlists, corporate bookings, and notifications all untouched

**Where:** `classes.ts` `cancel` (lines 132-154). The whole mutation, in full:

```ts
const cls = await ctx.db.update(classes).set({ cancelled: true })
  .where(eq(classes.id, input.id)).returning().get();
// ...NOT_FOUND check...
await ctx.db.update(bookings)
  .set({ status: "cancelled", cancelledAt: new Date().toISOString() })
  .where(and(eq(bookings.classId, input.id), eq(bookings.status, "booked")));
return cls;
```

That's the entire function. `classes.ts`'s imports (line 4) are `classes, bookings, users` only — no `memberships`, no `corporateBookings`, no `notifications`. The four failures below aren't four independent omissions; they're symptoms of one function that only ever had the ability to touch two of the four tables a real class cancellation needs to touch.

**Four distinct failures, each independently reproducible:**

1. **No credit refund.** The `bookings` update flips matching rows to `status: "cancelled"` but never reads or writes `memberships.creditsRemaining`. **Repro:** book a class as a member with a real membership (note `creditsRemaining` drops by the class's `creditCost`, per `bookings.book`). Have an admin call `classes.cancel` on that class. The booking flips to `cancelled`; `creditsRemaining` is unchanged from its post-booking value — the member is out those credits for a class the gym cancelled, not them. Contrast with member-initiated `bookings.cancel` (≥12h out), which does refund in the equivalent situation: this path is strictly worse for the member than cancelling it themselves.

2. **Waitlisted bookings are silently abandoned.** The update filters `eq(bookings.status, "booked")` — a `waitlisted` row for the same class matches neither this filter nor any other code path. **Repro:** get a member waitlisted on a full class, then have an admin cancel that class. Query that member's bookings — still `status: "waitlisted"`, `classId` pointing at a class with `cancelled: true`. Nothing in the app ever revisits or resolves it; the member is permanently waiting on a class that will never run.

3. **`corporateBookings` is never touched at all.** Not filtered out of the update — not referenced by the function, period. **Repro:** book a class via `corporateBookings.book` (status `booked`, company pool decremented by `creditCost`). Admin cancels that class via `classes.cancel`. Query `corporateBookings` for that row (or `adminCompanies.getById`'s `recentBookings`) — still `status: "booked"`, pool never credited back. The company paid for a seat in a class that no longer exists, with nothing in the data to surface that.

4. **No notification of any kind is sent.** The schema's `class_cancelled` type (`schema.ts:134`) exists specifically to describe this event, and `seed.ts` hand-inserts one sample `class_cancelled` row (bug #6, expanded above) — but `classes.cancel` doesn't import `notifications` and inserts nothing. This is the sharpest instance of bug #6's pattern: `class_cancelled`'s one obvious call site is this exact function, and it was written without it. **Repro:** after failure 1 or 3's repro, check `notifications` for the affected member or company contact — no new row. They find out only by separately noticing the booking is gone or the listing shows `cancelled`.

**Why this is likely the most consequential finding in the app:** the rest of this document is edge-case timing (waitlist ties, concurrent requests) or one wrong number in one admin report. This is a routine admin action — the gym cancels a class, for ordinary reasons like a sick trainer or low signup — that silently costs members real credits, strands waitlisted members on a dead class, leaves a company's pool permanently short, and tells no one anything happened. Every other bug in this file is more contained than this one.

**Decision:** documented only, not fixed, despite the severity — same standing reasoning as everywhere else in this file except #9: what "fixed" means here (full refund? partial? a grace window to un-cancel? does a corporate refund route through different logic than an individual one?) is a product decision outside this refactor's authority or scope. Flagged with full repro so it's a visible, informed deferral rather than something a reviewer has to find themselves.

Given the severity, all four failures are also reproduced directly as characterization tests in `test/classes.test.ts` (`#10.1`-`#10.4`) — the same red/green proof bugs #1-9 have, rather than prose alone. #11-#14 remain documentation-only (see `coverage-matrix.md`).

---

### 11. `plans.subscribe` has no active-membership check — a member can hold several simultaneously-active memberships, and credits on all but one become unreachable

**Where:** `plans.ts` `subscribe` (lines 21-70) inserts a new `memberships` row unconditionally — no check against the caller's existing memberships. `activeMembershipFor` (`bookings.ts` lines 10-27), the only place that later reads back "the" active membership, orders by `endDate` descending and takes one row — of several simultaneously-active memberships, only the latest-`endDate` one is ever used for booking.

**Repro:** subscribe to a second plan while credits remain on the first (both rows land `status: "active"`, both have a `payments` row — lines 60-67). Book a class — `activeMembershipFor` returns only the later-`endDate` membership; the other's credits are never read or decremented again. Paid for, stranded.

**Decision:** documented only — blocking a second subscription vs. carrying over or refunding the old one's credits is a product call this refactor doesn't own.

---

### 12. `payments.refund` never touches `bookings` — a member keeps attending classes booked with a membership that was just refunded

**Where:** `payments.ts` `refund` (lines 73-107) updates `payments.status` to `refunded` and, if a membership is linked, cancels it (lines 99-104) — it never reads or writes `bookings`.

**Repro:** book classes with credits from a membership, then refund the payment tied to it. The membership flips to `cancelled`, but those bookings stay `status: "booked"`, and staff can still `markAttended` them — `bookings.markAttended` checks only booking existence and `status === 'booked'`, nothing about the linked membership. The member keeps attending on a membership the gym already refunded.

**Decision:** documented only — whether a refund should retroactively cancel already-`booked` seats is a product decision this refactor isn't positioned to make.

---

### 13. `trainers.checkAvailability` computes a real conflict check and is never called from anywhere

**Where:** `trainers.ts` `checkAvailability` (lines 136-210) is a fully implemented trainer-conflict check with exactly one reference in the whole `src/` tree — its own definition (`grep -rn "checkAvailability" src`). `classes.ts` `create`/`update` (lines 81-130), the two places a trainer actually gets assigned a time slot, never call into it.

**Repro:** create two classes for the same trainer with overlapping `startsAt`/`durationMin` windows via `classes.create`. Both succeed, no error — `checkAvailability` would flag exactly this as a conflict, but nothing invokes it.

**Decision:** documented only — wiring it in would make a request that succeeds today start failing, which is out of scope regardless of how clearly it looks intended.

---

### 14. `companyMembers.linkMember`'s duplicate check is scoped to one company, not to the member — a member can be actively linked to more than one company, and which one "counts" is picked by an unordered query

**Where:** `admin-companies.ts` `linkMember` (lines 145-201)'s duplicate guard checks `(userId, companyId)` together, not `userId` alone — stated precisely because the gap is narrower than "there is no check": it blocks re-linking to the same company but not linking to a second, different one. `corporate-bookings.ts` `getCompanyForMember` (lines 17-32) then picks whichever active-company link an unordered query (`.get()`, no `.orderBy`) returns first.

**Repro:** link one member to two different active companies — neither `linkMember` call is rejected. Book a corporate class — the company charged is whichever `getCompanyForMember` happens to return first, not necessarily the expected one.

**Decision:** documented only — whether a member should belong to one company only, or multi-company membership is intentional and needs a real tie-break, is a product call this refactor doesn't own.
