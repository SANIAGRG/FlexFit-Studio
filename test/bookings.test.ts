import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";
import { createTestDb, type TestDb } from "./helpers/db";
import { createTestCaller } from "./helpers/caller";
import {
  makeUser,
  makeMembership,
  makeClass,
  fillClassBookings,
} from "./helpers/fixtures";
import {
  memberships as membershipsTable,
  bookings as bookingsTable,
  classes as classesTable,
} from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * Characterization tests: they pin down what the unrefactored router
 * actually does today, including the documented bugs in
 * documents/known-issues.md. Do not "fix" a test to match what the code
 * *should* do — if a test disagrees with source, the test is wrong, and if
 * it disagrees with the behavior spec, the spec is wrong. Both must be
 * updated from source, never from expectation.
 */
describe("bookings router", () => {
  let db: TestDb;
  let close: () => void;

  beforeAll(() => {
    const testDb = createTestDb();
    db = testDb.db;
    close = testDb.close;
  });

  afterAll(() => close());
  afterEach(() => vi.useRealTimers());

  describe("book", () => {
    it("charges credits and confirms the seat when there's room", async () => {
      const member = await makeUser(db);
      const membership = await makeMembership(db, member.id, { creditsRemaining: 5 });
      const cls = await makeClass(db, { capacity: 10, creditCost: 2 });

      const caller = createTestCaller(db, member);
      const booking = await caller.bookings.book({ classId: cls.id });

      expect(booking.status).toBe("booked");
      expect(booking.creditsUsed).toBe(2);

      const updated = await db
        .select()
        .from(membershipsTable)
        .where(eq(membershipsTable.id, membership.id))
        .get();
      expect(updated?.creditsRemaining).toBe(3);
    });

    it("does not decrement credits for an unlimited (>=999) membership", async () => {
      const member = await makeUser(db);
      const membership = await makeMembership(db, member.id, { creditsRemaining: 999 });
      const cls = await makeClass(db, { capacity: 10, creditCost: 3 });

      const caller = createTestCaller(db, member);
      const booking = await caller.bookings.book({ classId: cls.id });

      expect(booking.creditsUsed).toBe(3);

      const updated = await db
        .select()
        .from(membershipsTable)
        .where(eq(membershipsTable.id, membership.id))
        .get();
      expect(updated?.creditsRemaining).toBe(999);
    });

    it("waitlists with zero credits charged once the class is at capacity", async () => {
      const cls = await makeClass(db, { capacity: 1, creditCost: 1 });
      await fillClassBookings(db, cls, 1);

      const member = await makeUser(db);
      await makeMembership(db, member.id, { creditsRemaining: 5 });
      const caller = createTestCaller(db, member);
      const booking = await caller.bookings.book({ classId: cls.id });

      expect(booking.status).toBe("waitlisted");
      expect(booking.creditsUsed).toBe(0);

      const membership = await db
        .select()
        .from(membershipsTable)
        .where(eq(membershipsTable.userId, member.id))
        .get();
      expect(membership?.creditsRemaining).toBe(5);
    });

    it("rejects a second active booking for the same class", async () => {
      const member = await makeUser(db);
      await makeMembership(db, member.id, { creditsRemaining: 5 });
      const cls = await makeClass(db, { capacity: 10 });
      const caller = createTestCaller(db, member);

      await caller.bookings.book({ classId: cls.id });
      await expect(caller.bookings.book({ classId: cls.id })).rejects.toMatchObject({
        code: "CONFLICT",
        message: "You are already on the list for this class.",
      });
    });

    it("rejects booking without an active membership", async () => {
      const member = await makeUser(db);
      const cls = await makeClass(db, { capacity: 10 });
      const caller = createTestCaller(db, member);

      await expect(caller.bookings.book({ classId: cls.id })).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "An active membership is required to book classes.",
      });
    });

    it("rejects booking with insufficient (non-unlimited) credits", async () => {
      const member = await makeUser(db);
      await makeMembership(db, member.id, { creditsRemaining: 1 });
      const cls = await makeClass(db, { capacity: 10, creditCost: 2 });
      const caller = createTestCaller(db, member);

      await expect(caller.bookings.book({ classId: cls.id })).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "Not enough class credits remaining.",
      });
    });

    it("rejects booking a cancelled class", async () => {
      const member = await makeUser(db);
      await makeMembership(db, member.id, { creditsRemaining: 5 });
      const cls = await makeClass(db, { cancelled: true });
      const caller = createTestCaller(db, member);

      await expect(caller.bookings.book({ classId: cls.id })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "This class has been cancelled.",
      });
    });

    it("rejects booking a class that has already started", async () => {
      const member = await makeUser(db);
      await makeMembership(db, member.id, { creditsRemaining: 5 });
      const cls = await makeClass(db, { hoursFromNow: -1 });
      const caller = createTestCaller(db, member);

      await expect(caller.bookings.book({ classId: cls.id })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "This class has already started.",
      });
    });

    it("rejects booking a nonexistent class", async () => {
      const member = await makeUser(db);
      const caller = createTestCaller(db, member);

      await expect(caller.bookings.book({ classId: 999_999 })).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "Class not found.",
      });
    });
  });

  describe("cancel", () => {
    it("refunds credits when cancelling >= 12h before class start", async () => {
      const member = await makeUser(db);
      const membership = await makeMembership(db, member.id, { creditsRemaining: 5 });
      const cls = await makeClass(db, { hoursFromNow: 20, creditCost: 2 });
      const caller = createTestCaller(db, member);
      const booking = await caller.bookings.book({ classId: cls.id });

      const result = await caller.bookings.cancel({ bookingId: booking.id });
      expect(result).toEqual({ ok: true, refunded: true });

      const updated = await db
        .select()
        .from(membershipsTable)
        .where(eq(membershipsTable.id, membership.id))
        .get();
      expect(updated?.creditsRemaining).toBe(5);
    });

    it("does not refund credits when cancelling < 12h before class start", async () => {
      const member = await makeUser(db);
      const membership = await makeMembership(db, member.id, { creditsRemaining: 5 });
      const cls = await makeClass(db, { hoursFromNow: 6, creditCost: 2 });
      const caller = createTestCaller(db, member);
      const booking = await caller.bookings.book({ classId: cls.id });

      const result = await caller.bookings.cancel({ bookingId: booking.id });
      expect(result).toEqual({ ok: true, refunded: false });

      const updated = await db
        .select()
        .from(membershipsTable)
        .where(eq(membershipsTable.id, membership.id))
        .get();
      expect(updated?.creditsRemaining).toBe(3);
    });

    it("treats exactly 12h remaining as refundable (boundary is inclusive)", async () => {
      const member = await makeUser(db);
      await makeMembership(db, member.id, { creditsRemaining: 5 });
      const startsAt = new Date("2026-06-01T12:00:00.000Z");
      const cls = await makeClass(db, { startsAt: startsAt.toISOString(), creditCost: 1 });

      vi.useFakeTimers({ now: new Date("2026-05-31T00:00:00.000Z") });
      const caller = createTestCaller(db, member);
      const booking = await caller.bookings.book({ classId: cls.id });

      vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z")); // exactly 12h before startsAt
      const result = await caller.bookings.cancel({ bookingId: booking.id });

      expect(result.refunded).toBe(true);
    });

    it("promotes the longest-waiting waitlisted booking when a booked seat frees up", async () => {
      const cls = await makeClass(db, { capacity: 1, creditCost: 1 });

      const first = await makeUser(db);
      await makeMembership(db, first.id, { creditsRemaining: 5 });
      const firstBooking = await createTestCaller(db, first).bookings.book({
        classId: cls.id,
      });

      const second = await makeUser(db);
      await makeMembership(db, second.id, { creditsRemaining: 5 });
      const secondBooking = await createTestCaller(db, second).bookings.book({
        classId: cls.id,
      });
      expect(secondBooking.status).toBe("waitlisted");

      await createTestCaller(db, first).bookings.cancel({ bookingId: firstBooking.id });

      const promoted = await db
        .select()
        .from(bookingsTable)
        .where(eq(bookingsTable.id, secondBooking.id))
        .get();
      expect(promoted?.status).toBe("booked");
      expect(promoted?.creditsUsed).toBe(1);

      const secondMembership = await db
        .select()
        .from(membershipsTable)
        .where(eq(membershipsTable.userId, second.id))
        .get();
      // Documented bug (known-issues.md #1): promotion decrements credits
      // unconditionally via Math.max(0, ...), even though this member could
      // afford it here. Pinned as-is; not a case where affordability was in question.
      expect(secondMembership?.creditsRemaining).toBe(4);
    });

    it("promotes a waitlisted member for free even with zero credits (known-issues.md #1)", async () => {
      const cls = await makeClass(db, { capacity: 1, creditCost: 3 });

      const first = await makeUser(db);
      await makeMembership(db, first.id, { creditsRemaining: 5 });
      const firstBooking = await createTestCaller(db, first).bookings.book({
        classId: cls.id,
      });

      const broke = await makeUser(db);
      await makeMembership(db, broke.id, { creditsRemaining: 0 });
      // Can't book directly (would be rejected for insufficient credits) —
      // insert the waitlisted row directly to reach the state that arises in
      // practice via a class that was full before this member's credits ran out.
      const brokeMembership = await db
        .select()
        .from(membershipsTable)
        .where(eq(membershipsTable.userId, broke.id))
        .get();
      const waitlistedRow = await db
        .insert(bookingsTable)
        .values({
          classId: cls.id,
          userId: broke.id,
          membershipId: brokeMembership!.id,
          status: "waitlisted",
          creditsUsed: 0,
        })
        .returning()
        .get();

      await createTestCaller(db, first).bookings.cancel({ bookingId: firstBooking.id });

      const promoted = await db
        .select()
        .from(bookingsTable)
        .where(eq(bookingsTable.id, waitlistedRow.id))
        .get();
      expect(promoted?.status).toBe("booked");

      const updated = await db
        .select()
        .from(membershipsTable)
        .where(eq(membershipsTable.id, brokeMembership!.id))
        .get();
      expect(updated?.creditsRemaining).toBe(0); // Math.max(0, 0 - 3) = 0, never blocked
    });

    it("allows staff to cancel another member's booking", async () => {
      const member = await makeUser(db);
      await makeMembership(db, member.id, { creditsRemaining: 5 });
      const cls = await makeClass(db, { hoursFromNow: 48 });
      const booking = await createTestCaller(db, member).bookings.book({
        classId: cls.id,
      });

      const staff = await makeUser(db, { role: "admin" });
      const result = await createTestCaller(db, staff).bookings.cancel({
        bookingId: booking.id,
      });

      expect(result.ok).toBe(true);
    });

    it("rejects cancellation by a non-owner, non-staff member", async () => {
      const member = await makeUser(db);
      await makeMembership(db, member.id, { creditsRemaining: 5 });
      const cls = await makeClass(db, { hoursFromNow: 48 });
      const booking = await createTestCaller(db, member).bookings.book({
        classId: cls.id,
      });

      const stranger = await makeUser(db);
      await expect(
        createTestCaller(db, stranger).bookings.cancel({ bookingId: booking.id }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "You cannot cancel this booking.",
      });
    });

    it("rejects cancelling a booking that is already cancelled", async () => {
      const member = await makeUser(db);
      await makeMembership(db, member.id, { creditsRemaining: 5 });
      const cls = await makeClass(db, { hoursFromNow: 48 });
      const caller = createTestCaller(db, member);
      const booking = await caller.bookings.book({ classId: cls.id });
      await caller.bookings.cancel({ bookingId: booking.id });

      await expect(caller.bookings.cancel({ bookingId: booking.id })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "This booking is no longer active.",
      });
    });
  });

  describe("markAttended", () => {
    it("checks in a booked member and records the checkin source", async () => {
      const member = await makeUser(db);
      await makeMembership(db, member.id, { creditsRemaining: 5 });
      const cls = await makeClass(db, { hoursFromNow: 48 });
      const booking = await createTestCaller(db, member).bookings.book({
        classId: cls.id,
      });

      const staff = await makeUser(db, { role: "trainer" });
      const result = await createTestCaller(db, staff).bookings.markAttended({
        bookingId: booking.id,
        source: "kiosk",
      });

      expect(result).toEqual({ ok: true });
      const updated = await db
        .select()
        .from(bookingsTable)
        .where(eq(bookingsTable.id, booking.id))
        .get();
      expect(updated?.status).toBe("attended");
    });

    it("rejects checking in a booking that isn't confirmed", async () => {
      const cls = await makeClass(db, { capacity: 1 });
      await fillClassBookings(db, cls, 1);
      const member = await makeUser(db);
      await makeMembership(db, member.id, { creditsRemaining: 5 });
      const booking = await createTestCaller(db, member).bookings.book({
        classId: cls.id,
      });
      expect(booking.status).toBe("waitlisted");

      const staff = await makeUser(db, { role: "admin" });
      await expect(
        createTestCaller(db, staff).bookings.markAttended({ bookingId: booking.id }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "Only confirmed bookings can be checked in.",
      });
    });

    it("rejects markAttended from a non-staff member", async () => {
      const member = await makeUser(db);
      await makeMembership(db, member.id, { creditsRemaining: 5 });
      const cls = await makeClass(db, { hoursFromNow: 48 });
      const booking = await createTestCaller(db, member).bookings.book({
        classId: cls.id,
      });

      await expect(
        createTestCaller(db, member).bookings.markAttended({ bookingId: booking.id }),
      ).rejects.toMatchObject({ code: "FORBIDDEN", message: "Staff only." });
    });
  });

  describe("mine", () => {
    it("filters out past bookings by default but includes them with includePast: true", async () => {
      const member = await makeUser(db);
      await makeMembership(db, member.id, { creditsRemaining: 5 });
      const future = await makeClass(db, { hoursFromNow: 48 });
      const past = await makeClass(db, { hoursFromNow: 48 }); // booked, then class time moved into the past
      const caller = createTestCaller(db, member);
      await caller.bookings.book({ classId: future.id });
      const pastBooking = await caller.bookings.book({ classId: past.id });

      // Move the class itself into the past after booking (book() would
      // otherwise reject a class that's already started).
      await db
        .update(classesTable)
        .set({ startsAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
        .where(eq(classesTable.id, past.id));

      const upcoming = await caller.bookings.mine();
      expect(upcoming.map((b) => b.classId)).toEqual([future.id]);

      const all = await caller.bookings.mine({ includePast: true });
      expect(all.map((b) => b.classId).sort()).toEqual([future.id, past.id].sort());
      expect(all.find((b) => b.id === pastBooking.id)).toBeTruthy();
    });
  });

  describe("checkinCountFor", () => {
    it(
      "only counts individual checkins — corporate attendance is invisible here too " +
        "(known-issues.md #5, seen from the individual side)",
      async () => {
        const cls = await makeClass(db, { hoursFromNow: 48 });
        const member = await makeUser(db);
        await makeMembership(db, member.id, { creditsRemaining: 5 });
        const booking = await createTestCaller(db, member).bookings.book({
          classId: cls.id,
        });
        const staff = await makeUser(db, { role: "admin" });
        await createTestCaller(db, staff).bookings.markAttended({
          bookingId: booking.id,
        });

        const result = await createTestCaller(db, staff).bookings.checkinCountFor({
          classId: cls.id,
        });
        expect(result.count).toBe(1);
      },
    );
  });

  describe("waitlisted", () => {
    it("reports 1-indexed queue position ordered by booking time", { timeout: 10000 }, async () => {
      // bookedAt is set by SQLite's own CURRENT_TIMESTAMP (1s resolution),
      // generated inside the engine at insert time — vi.useFakeTimers only
      // fakes the JS clock, so it can't move this. A real wall-clock delay
      // is the only way to force bookedAt to actually differ; see the
      // tie-handling test below for what happens without one.
      const cls = await makeClass(db, { capacity: 1 });
      await fillClassBookings(db, cls, 1);

      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const members = [];
      for (let i = 0; i < 3; i++) {
        const m = await makeUser(db);
        await makeMembership(db, m.id, { creditsRemaining: 5 });
        await createTestCaller(db, m).bookings.book({ classId: cls.id });
        members.push(m);
        await wait(1100);
      }

      const positions = await Promise.all(
        members.map(async (m) => {
          const rows = await createTestCaller(db, m).bookings.waitlisted();
          return rows.find((r) => r.classId === cls.id)?.position;
        }),
      );

      expect(positions).toEqual([1, 2, 3]);
    });

    it("gives every booking in the same wall-clock second the same position (known-issues.md #8)", async () => {
      // bookedAt has 1-second resolution. Position is "count of others with
      // a strictly earlier bookedAt" — ties don't count as earlier, so
      // simultaneous waitlist joins all report position 1, not 1/2/3. Found
      // via this characterization test, not called out in the original brief.
      //
      // Inserting the waitlisted rows directly with an identical explicit
      // bookedAt (rather than calling bookings.book three times in a row and
      // hoping real wall-clock time doesn't cross a second boundary) makes
      // this deterministic — the original timing-dependent version passed in
      // isolation but flaked under full-suite parallel load, which is a sign
      // it was asserting on timing luck rather than on the tie behavior itself.
      const cls = await makeClass(db, { capacity: 1 });
      await fillClassBookings(db, cls, 1);

      const sameInstant = new Date().toISOString().replace("T", " ").slice(0, 19);
      const members = [];
      for (let i = 0; i < 3; i++) {
        const m = await makeUser(db);
        await makeMembership(db, m.id, { creditsRemaining: 5 });
        await db.insert(bookingsTable).values({
          classId: cls.id,
          userId: m.id,
          status: "waitlisted",
          creditsUsed: 0,
          bookedAt: sameInstant,
        });
        members.push(m);
      }

      const positions = await Promise.all(
        members.map(async (m) => {
          const rows = await createTestCaller(db, m).bookings.waitlisted();
          return rows.find((r) => r.classId === cls.id)?.position;
        }),
      );

      expect(positions).toEqual([1, 1, 1]);
    });
  });
});
