# Behavior spec

Per-router contract as it exists today, in unrefactored code. Written together with the characterization tests in `test/` so the spec has test evidence behind it — see `coverage-matrix.md` for the mapping. Priority order per the working brief: `bookings` → `corporate-bookings` → `reschedules` → `payments`; depth is not equal across routers.

Status as of this session (Aug 8 work): `bookings` complete. `corporate-bookings` and `reschedules` in progress below. `payments` not started.

---

## `bookings` router (`src/server/routers/bookings.ts`)

### Constants

- `FREE_CANCELLATION_HOURS = 12` — cancelling `>= 12h` before class start refunds the credit; cancelling later still frees the seat but forfeits the credit.
- `UNLIMITED_CREDITS = 999` — a membership with `creditsRemaining >= 999` is treated as unlimited: booking never decrements it, and cancelling never increments it back (see credits note below).

### `mine` (protected query)

**Input:** `{ includePast?: boolean = false }` (whole input optional, defaults to `{}`).

Returns the caller's bookings joined with class details (id, status, creditsUsed, bookedAt, classId, className, room, startsAt, durationMin, cancelled), ordered by `startsAt` ascending. If `includePast` is false (default), rows where `startsAt < now` are filtered out **client-side after the query** (not in SQL) — the query fetches all bookings regardless, then filters in JS.

### `book` (protected mutation)

**Input:** `{ classId: number }`.

Validation order (each throws immediately, no partial state before the throw):

1. Class must exist → `NOT_FOUND` `"Class not found."`
2. Class must not be cancelled → `BAD_REQUEST` `"This class has been cancelled."`
3. Class must not have started (`hoursUntil(startsAt) <= 0` fails) → `BAD_REQUEST` `"This class has already started."`
4. Caller must not already hold an active (`booked` or `waitlisted`) booking for this class → `CONFLICT` `"You are already on the list for this class."`
5. Caller must have an active membership (status `active`, `endDate >= today`; if multiple, the one with the latest `endDate` wins) → `FORBIDDEN` `"An active membership is required to book classes."`
6. Unless unlimited (`creditsRemaining >= 999`), membership must have `creditsRemaining >= class.creditCost` → `FORBIDDEN` `"Not enough class credits remaining."`

Then: count existing `status = 'booked'` rows for the class (**individual `bookings` table only** — see cross-router note below). If `count >= capacity`, the new booking is created `waitlisted` with `creditsUsed: 0` and **no membership deduction happens, regardless of affordability**. Otherwise it's created `booked` with `creditsUsed: class.creditCost`, and if the membership isn't unlimited, `creditsRemaining` is decremented by that amount. Returns the created booking row.

### `cancel` (protected mutation)

**Input:** `{ bookingId: number }`.

1. Booking must exist → `NOT_FOUND` `"Booking not found."`
2. Caller must be the booking's owner, or staff (`admin`/`trainer`) → `FORBIDDEN` `"You cannot cancel this booking."`
3. Booking status must be `booked` or `waitlisted` → `BAD_REQUEST` `"This booking is no longer active."`

`refundable = hoursUntil(class.startsAt) >= 12 && booking.creditsUsed > 0`. Booking is set to `cancelled` with `cancelledAt = now` unconditionally.

If refundable and the booking has a `membershipId`: **only if** the membership's *current* `creditsRemaining < 999` (i.e. not presently unlimited), credit the `creditsUsed` amount back. This guard means an unlimited-plan member's cancellation is reported `refunded: true` (since `creditsUsed` was recorded as nonzero at booking time even though nothing was ever decremented) but no credits actually move — see `known-issues.md` for why this isn't scored as a new bug (it's a documented sentinel interaction, not something to fix).

If the cancelled booking's *prior* status was `booked` (not `waitlisted`): the earliest-`bookedAt` `waitlisted` booking for the same class, if any, is promoted to `booked` with `creditsUsed = class.creditCost`. If that promoted booking has a `membershipId`, credits are decremented by `Math.max(0, creditsRemaining - creditCost)` — **unconditionally, regardless of whether `creditsRemaining` covers the cost** (see `known-issues.md` bug #1). No notification is sent to the promoted member (bug #6).

Returns `{ ok: true, refunded: boolean }`.

### `markAttended` (staff mutation)

**Input:** `{ bookingId: number, source?: "front_desk" | "kiosk" | "app" = "front_desk" }`.

1. Booking must exist → `NOT_FOUND` `"Booking not found."`
2. Booking status must be exactly `booked` → `BAD_REQUEST` `"Only confirmed bookings can be checked in."` (Note: a `waitlisted`, `attended`, `no_show`, or `cancelled` booking all hit this same message — can't be checked in twice, can't check in someone who was never confirmed.)

Sets status to `attended`, inserts a `checkins` row with the given `source` (default `front_desk`). Returns `{ ok: true }`.

### `rosterFor` (staff query)

**Input:** `{ classId: number }`. Returns all bookings for the class (any status) joined with member name/email, ordered by `bookedAt` ascending. No filtering by status — cancelled and waitlisted rows are included.

### `upcomingForMember` (staff query)

**Input:** `{ userId: number, hoursAhead?: number = 2 }`. Returns the member's `booked` (only — not waitlisted) bookings for non-cancelled classes starting between now and `now + hoursAhead` hours.

### `checkinCountFor` (staff query)

**Input:** `{ classId: number }`. Counts `checkins` rows inner-joined to `bookings` for that class. Because the join is to `bookings` specifically, corporate check-ins (which have `checkins.bookingId = null`) are never counted here — see `known-issues.md` bug #5.

### `waitlisted` (protected query)

Returns the caller's `waitlisted` bookings with a computed `position`: `1 + count of other waitlisted bookings for the same class with an earlier bookedAt`. Ties in `bookedAt` are not specially handled (SQLite `bookedAt` has second-level granularity via `CURRENT_TIMESTAMP`, so near-simultaneous bookings can tie — not exercised by seed data or tests yet).

---

## `corporate-bookings` router (`src/server/routers/corporate-bookings.ts`)

Structurally parallel to `bookings` — same procedure shapes for `mine`/`book`/`cancel`/`markAttended`/`rosterFor` — but operates on the separate `corporateBookings` table and a company credit pool instead of a personal membership. Key differences from `bookings`, not similarities, are what matters for a refactor:

### Constant

- `CORPORATE_FREE_CANCELLATION_HOURS = 24` — double the individual window. Intentionally different; see `decision-log.md`.

### `book`

Same NOT_FOUND/cancelled/already-started/duplicate-booking checks as individual `book`, with corporate-specific eligibility in place of membership checks:

5. Caller must be linked to an **active** company (`companyMembers` → `companies` where `companies.active = true`) → `FORBIDDEN` `"You are not linked to an active company."`
6. Company's `creditPoolBalance` must be `>= class.creditCost` → `FORBIDDEN` `"Your company does not have enough credits."` (No unlimited-credits concept on the corporate side — there is no sentinel equivalent to `UNLIMITED_CREDITS` for company pools.)

Capacity check counts **`corporateBookings` rows only**, independent of the individual `bookings` table — see cross-router note below. If full, `waitlisted`/`creditsUsed: 0`, no pool deduction. Otherwise `booked`, pool decremented by `creditCost` unconditionally (no unlimited guard needed since none exists).

### `cancel`

Same ownership/staff/status checks. `refundable = hoursUntil >= 24 && creditsUsed > 0`. If refundable, the company pool is credited back **unconditionally** (no `< UNLIMITED_CREDITS`-style guard — there's nothing to guard against on this side).

Waitlist promotion on freeing a `booked` seat: promotes the earliest-waitlisted corporate booking to `booked` with `creditsUsed = creditCost` **always**, but only decrements the pool `if (company.creditPoolBalance >= row.cls.creditCost)` — i.e. the promotion always happens, the ledger update is conditional. This is the mirror image of individual's bug (which always adjusts the ledger, unconditionally) — see `known-issues.md` bug #1, the two are different wrong answers to the same scenario, not the same bug in two files.

### `markAttended`

Inserts `{ userId, bookingId: null }` into `checkins` — ignores its own `source` input entirely (always persists as the column default, `front_desk`) and doesn't link back to the corporate booking. See `known-issues.md` bug #5.

### Not present in this router

No `upcomingForMember`, no `checkinCountFor`, no `waitlisted` query (corporate members can't see their own queue position — there's no endpoint for it, though the underlying wait-list mechanics exist identically to individual bookings).

---

## `reschedules` router (`src/server/routers/reschedules.ts`)

**Individual bookings only.** No `corporateBookings` import, no corporate concept anywhere in the file — corporate bookings cannot be rescheduled (`known-issues.md` notes this as a feature gap, not a bug to fix).

### Constant

- `FREE_RESCHEDULE_HOURS = 4` — deliberately smaller/more permissive than either cancellation window; reschedule is a different, more generous policy by design, not a bug.

### `reschedule` (protected mutation) and `validateReschedule` (protected query)

Same ~11-step validation ladder, duplicated between the two (mutation throws `TRPCError`, query returns `{ valid: false, reason }`); message strings are hand-copied between them today, which is exactly the highest-value/lowest-risk extraction target (see `architecture-decisions.md`). In order:

1. Original booking must exist → `NOT_FOUND` `"Booking not found."` / `{ valid: false, reason: "Booking not found." }`
2. Caller must own it → `FORBIDDEN` `"You cannot reschedule this booking."` / same reason string
3. Status must be `booked` or `waitlisted` → `BAD_REQUEST` `"This booking is no longer active."` / same
4. `hoursUntil(originalClass.startsAt) >= 4` → else `BAD_REQUEST` `` `You can only reschedule up to ${FREE_RESCHEDULE_HOURS} hours before the class starts.` `` / same (note: uses the *original* class's time remaining, not the target's)
5. Target class must exist → `NOT_FOUND` `"Target class not found."` / same
6. Target class `name` must **exactly equal** the original class's `name` → `BAD_REQUEST` `"You can only reschedule to a class with the same name."` — reschedule is same-class-different-session only, not "any class"
7. Target class id must differ from original → `BAD_REQUEST` `"You are already booked for this class."`
8. Target class must not have started → `BAD_REQUEST` `"This class has already started."`
9. Target class must not be cancelled → `BAD_REQUEST` `"This class has been cancelled."`
10. Caller must not already have an active booking on the target class → `CONFLICT` `"You already have an active booking for this class."`
11. Target-full check (count of `status = 'booked'` on target class `>= capacity`) determines whether the new booking lands `booked` or `waitlisted` — not an error, just changes the outcome.

**Not checked, anywhere in either path:** membership status. `activeMembershipFor` is defined and dead (`known-issues.md` bug #4).

**`reschedule` side effects:** inserts the new booking with `creditsUsed: originalBooking.creditsUsed` carried forward unchanged (bug #3 if the original was waitlisted — see `known-issues.md`), cancels the original booking (`status: "cancelled"`, `cancelledAt: now`), and inserts a `reschedules` audit row (`fromBookingId`/`toBookingId`/`fromClassId`/`toClassId`). **Does not** attempt to promote anyone off the original class's waitlist even if the vacated seat was `booked` (bug #2). Returns `{ ok: true, newBooking, newStatus }`.

**`validateReschedule`** performs every check above (steps 1-10) and additionally reports `targetIsFull` (step 11) as data rather than a pass/fail — it never fails on capacity, it just tells the caller what will happen. It does not simulate credits or insert anything; it's read-only, meant to let the UI preview before the member commits.

### `history` (protected query)

Returns the caller's past reschedules with denormalized from/to class name, time, and room via correlated subqueries. No pagination.

---

## Cross-router note: occupancy counting (six sites, not four)

The four sites named in the original brief undercount by two. All six, and what each one means:

| # | Site | Table | Statuses counted | Purpose |
|---|---|---|---|---|
| 1 | `bookings.book` | `bookings` | `booked` | is *this* class full for *this* (individual) booking attempt |
| 2 | `corporateBookings.book` | `corporateBookings` | `booked` | same, corporate side |
| 3 | `reschedules.reschedule` | `bookings` | `booked` | is the *target* class full |
| 4 | `reschedules.validateReschedule` | `bookings` | `booked` | same, read-only preview |
| 5 | `classes.list` → `spotsLeft`/`full` | `bookings` | `booked` | what members see on the schedule |
| 6 | `admin.classUtilisation` | `bookings` | `booked` **and** `attended` | retrospective utilisation report |

Sites 1-5 all mean the same thing ("is there a free seat right now") but only ever look at one of the two booking tables each — individual sites (1, 3, 4, 5) never see corporate bookings and vice versa (2). A class with `capacity: 10` can hold 10 `booked` individual **and** 10 `booked` corporate bookings simultaneously before either side sees itself as full — 20 people, 10-person room. Site 5 (`classes.list`) is what members actually browse, so a class fully booked out by a company shows as empty to individual members.

Site 6 counts a different status set for a different purpose (a report about who used a slot, including people who showed up, not a live capacity gate) and must **not** be folded into a shared helper without an explicit status-set parameter, or the utilisation report silently starts excluding `attended` bookings.

See `architecture-decisions.md` for how the refactor's `capacity.ts` helper is shaped to preserve this rather than collapse it.
