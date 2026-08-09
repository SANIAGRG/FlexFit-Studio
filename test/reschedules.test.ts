import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDb } from "./helpers/db";
import { createTestCaller } from "./helpers/caller";
import { makeUser, makeMembership, makeClass, fillClassBookings } from "./helpers/fixtures";
import { bookings as bookingsTable, memberships as membershipsTable } from "@/db/schema";
import { eq } from "drizzle-orm";

describe("reschedules router", () => {
  let db: TestDb;
  let close: () => void;

  beforeAll(() => {
    const testDb = createTestDb();
    db = testDb.db;
    close = testDb.close;
  });

  afterAll(() => close());

  describe("reschedule — happy path", () => {
    it("moves the booking, carries credits forward, cancels the original, records history", async () => {
      const member = await makeUser(db);
      await makeMembership(db, member.id, { creditsRemaining: 5 });
      const from = await makeClass(db, { name: "Sunrise Yoga", hoursFromNow: 48, creditCost: 2 });
      const to = await makeClass(db, { name: "Sunrise Yoga", hoursFromNow: 72, creditCost: 2 });
      const caller = createTestCaller(db, member);
      const original = await caller.bookings.book({ classId: from.id });

      const result = await caller.reschedules.reschedule({
        fromBookingId: original.id,
        toClassId: to.id,
      });

      expect(result.ok).toBe(true);
      expect(result.newStatus).toBe("booked");
      expect(result.newBooking.creditsUsed).toBe(2); // carried forward, not recharged

      const originalRow = await db
        .select()
        .from(bookingsTable)
        .where(eq(bookingsTable.id, original.id))
        .get();
      expect(originalRow?.status).toBe("cancelled");

      const history = await caller.reschedules.history();
      expect(history).toHaveLength(1);
      expect(history[0].fromClassName).toBe("Sunrise Yoga");
      expect(history[0].toClassName).toBe("Sunrise Yoga");
    });

    it("waitlists the new booking when the target class is full", async () => {
      const member = await makeUser(db);
      await makeMembership(db, member.id, { creditsRemaining: 5 });
      const from = await makeClass(db, { name: "HIIT Circuit", hoursFromNow: 48 });
      const to = await makeClass(db, { name: "HIIT Circuit", hoursFromNow: 72, capacity: 1 });
      await fillClassBookings(db, to, 1);

      const caller = createTestCaller(db, member);
      const original = await caller.bookings.book({ classId: from.id });

      const result = await caller.reschedules.reschedule({
        fromBookingId: original.id,
        toClassId: to.id,
      });

      expect(result.newStatus).toBe("waitlisted");
    });
  });

  describe("reschedule / validateReschedule agreement", () => {
    // The query exists to predict the mutation. Nothing in source enforces
    // that they actually agree today (the ~11-step ladder is hand-copied
    // between them) — this is the test the extraction is meant to make
    // structurally guaranteed instead of merely hoped-for.
    const scenarios: Array<{
      name: string;
      setup: (
        db: TestDb,
      ) => Promise<{ fromBookingId: number; toClassId: number; owner: Awaited<ReturnType<typeof makeUser>> }>;
      expectedReason: string;
    }> = [
      {
        name: "booking not found",
        setup: async (db) => {
          const owner = await makeUser(db);
          const to = await makeClass(db, { name: "X" });
          return { fromBookingId: 999_999, toClassId: to.id, owner };
        },
        expectedReason: "Booking not found.",
      },
      {
        name: "not the owner",
        setup: async (db) => {
          const bookingOwner = await makeUser(db);
          await makeMembership(db, bookingOwner.id, { creditsRemaining: 5 });
          const from = await makeClass(db, { name: "Y", hoursFromNow: 48 });
          const to = await makeClass(db, { name: "Y", hoursFromNow: 72 });
          const booking = await createTestCaller(db, bookingOwner).bookings.book({
            classId: from.id,
          });
          const stranger = await makeUser(db);
          return { fromBookingId: booking.id, toClassId: to.id, owner: stranger };
        },
        expectedReason: "You cannot reschedule this booking.",
      },
      {
        name: "booking no longer active (already cancelled)",
        setup: async (db) => {
          const owner = await makeUser(db);
          await makeMembership(db, owner.id, { creditsRemaining: 5 });
          const from = await makeClass(db, { name: "Z", hoursFromNow: 48 });
          const to = await makeClass(db, { name: "Z", hoursFromNow: 72 });
          const caller = createTestCaller(db, owner);
          const booking = await caller.bookings.book({ classId: from.id });
          await caller.bookings.cancel({ bookingId: booking.id });
          return { fromBookingId: booking.id, toClassId: to.id, owner };
        },
        expectedReason: "This booking is no longer active.",
      },
      {
        name: "inside the 4h reschedule window",
        setup: async (db) => {
          const owner = await makeUser(db);
          await makeMembership(db, owner.id, { creditsRemaining: 5 });
          const from = await makeClass(db, { name: "W", hoursFromNow: 2 });
          const to = await makeClass(db, { name: "W", hoursFromNow: 72 });
          const booking = await createTestCaller(db, owner).bookings.book({
            classId: from.id,
          });
          return { fromBookingId: booking.id, toClassId: to.id, owner };
        },
        expectedReason:
          "You can only reschedule up to 4 hours before the class starts.",
      },
      {
        name: "target class not found",
        setup: async (db) => {
          const owner = await makeUser(db);
          await makeMembership(db, owner.id, { creditsRemaining: 5 });
          const from = await makeClass(db, { name: "V", hoursFromNow: 48 });
          const booking = await createTestCaller(db, owner).bookings.book({
            classId: from.id,
          });
          return { fromBookingId: booking.id, toClassId: 999_999, owner };
        },
        expectedReason: "Target class not found.",
      },
      {
        name: "target class has a different name",
        setup: async (db) => {
          const owner = await makeUser(db);
          await makeMembership(db, owner.id, { creditsRemaining: 5 });
          const from = await makeClass(db, { name: "Spin 45", hoursFromNow: 48 });
          const to = await makeClass(db, { name: "Boxing Fundamentals", hoursFromNow: 72 });
          const booking = await createTestCaller(db, owner).bookings.book({
            classId: from.id,
          });
          return { fromBookingId: booking.id, toClassId: to.id, owner };
        },
        expectedReason: "You can only reschedule to a class with the same name.",
      },
      {
        name: "target class is the same class",
        setup: async (db) => {
          const owner = await makeUser(db);
          await makeMembership(db, owner.id, { creditsRemaining: 5 });
          const from = await makeClass(db, { name: "Power Vinyasa", hoursFromNow: 48 });
          const booking = await createTestCaller(db, owner).bookings.book({
            classId: from.id,
          });
          return { fromBookingId: booking.id, toClassId: from.id, owner };
        },
        expectedReason: "You are already booked for this class.",
      },
      {
        name: "target class already started",
        setup: async (db) => {
          const owner = await makeUser(db);
          await makeMembership(db, owner.id, { creditsRemaining: 5 });
          const from = await makeClass(db, { name: "Mobility", hoursFromNow: 48 });
          const to = await makeClass(db, { name: "Mobility", hoursFromNow: -1 });
          const booking = await createTestCaller(db, owner).bookings.book({
            classId: from.id,
          });
          return { fromBookingId: booking.id, toClassId: to.id, owner };
        },
        expectedReason: "This class has already started.",
      },
      {
        name: "target class is cancelled",
        setup: async (db) => {
          const owner = await makeUser(db);
          await makeMembership(db, owner.id, { creditsRemaining: 5 });
          const from = await makeClass(db, { name: "Advanced Spin", hoursFromNow: 48 });
          const to = await makeClass(db, {
            name: "Advanced Spin",
            hoursFromNow: 72,
            cancelled: true,
          });
          const booking = await createTestCaller(db, owner).bookings.book({
            classId: from.id,
          });
          return { fromBookingId: booking.id, toClassId: to.id, owner };
        },
        expectedReason: "This class has been cancelled.",
      },
      {
        name: "already has an active booking on the target class",
        setup: async (db) => {
          const owner = await makeUser(db);
          await makeMembership(db, owner.id, { creditsRemaining: 5 });
          const from = await makeClass(db, { name: "Strength Basics", hoursFromNow: 48 });
          const to = await makeClass(db, { name: "Strength Basics", hoursFromNow: 72 });
          const caller = createTestCaller(db, owner);
          const booking = await caller.bookings.book({ classId: from.id });
          await caller.bookings.book({ classId: to.id });
          return { fromBookingId: booking.id, toClassId: to.id, owner };
        },
        expectedReason: "You already have an active booking for this class.",
      },
    ];

    for (const scenario of scenarios) {
      it(`agree on: ${scenario.name}`, async () => {
        const { fromBookingId, toClassId, owner } = await scenario.setup(db);
        const caller = createTestCaller(db, owner);

        const validation = await caller.reschedules.validateReschedule({
          fromBookingId,
          toClassId,
        });
        expect(validation).toEqual({ valid: false, reason: scenario.expectedReason });

        await expect(
          caller.reschedules.reschedule({ fromBookingId, toClassId }),
        ).rejects.toMatchObject({ message: scenario.expectedReason });
      });
    }
  });

  describe("documented bugs (known-issues.md)", () => {
    it("#2 — reschedule never promotes the waitlist when vacating a booked seat", async () => {
      const from = await makeClass(db, { name: "Bug2 Class", hoursFromNow: 48, capacity: 1 });
      const to = await makeClass(db, { name: "Bug2 Class", hoursFromNow: 72 });

      const holder = await makeUser(db);
      await makeMembership(db, holder.id, { creditsRemaining: 5 });
      const holderBooking = await createTestCaller(db, holder).bookings.book({
        classId: from.id,
      });

      const waiter = await makeUser(db);
      await makeMembership(db, waiter.id, { creditsRemaining: 5 });
      const waiterBooking = await createTestCaller(db, waiter).bookings.book({
        classId: from.id,
      });
      expect(waiterBooking.status).toBe("waitlisted");

      await createTestCaller(db, holder).reschedules.reschedule({
        fromBookingId: holderBooking.id,
        toClassId: to.id,
      });

      const waiterRow = await db
        .select()
        .from(bookingsTable)
        .where(eq(bookingsTable.id, waiterBooking.id))
        .get();
      // Contrast: bookings.cancel WOULD promote this. reschedule does not.
      expect(waiterRow?.status).toBe("waitlisted");
    });

    it("#3 — rescheduling a waitlisted booking produces a free booked seat", async () => {
      const from = await makeClass(db, { name: "Bug3 Class", hoursFromNow: 48, capacity: 1, creditCost: 3 });
      const to = await makeClass(db, { name: "Bug3 Class", hoursFromNow: 72, capacity: 10 });
      await fillClassBookings(db, from, 1);

      const member = await makeUser(db);
      await makeMembership(db, member.id, { creditsRemaining: 5 });
      const caller = createTestCaller(db, member);
      const waitlisted = await caller.bookings.book({ classId: from.id });
      expect(waitlisted.status).toBe("waitlisted");
      expect(waitlisted.creditsUsed).toBe(0);

      const result = await caller.reschedules.reschedule({
        fromBookingId: waitlisted.id,
        toClassId: to.id,
      });

      expect(result.newStatus).toBe("booked");
      expect(result.newBooking.creditsUsed).toBe(0); // confirmed seat, zero credits charged
    });

    it("#4 — reschedule succeeds with no active membership (activeMembershipFor is dead code)", async () => {
      const from = await makeClass(db, { name: "Bug4 Class", hoursFromNow: 48 });
      const to = await makeClass(db, { name: "Bug4 Class", hoursFromNow: 72 });

      const member = await makeUser(db);
      const membership = await makeMembership(db, member.id, { creditsRemaining: 5 });
      const caller = createTestCaller(db, member);
      const booking = await caller.bookings.book({ classId: from.id });

      // Expire the membership after booking, before rescheduling.
      await db
        .update(membershipsTable)
        .set({ status: "expired" })
        .where(eq(membershipsTable.id, membership.id));

      const result = await caller.reschedules.reschedule({
        fromBookingId: booking.id,
        toClassId: to.id,
      });

      expect(result.ok).toBe(true); // no FORBIDDEN despite the expired membership
    });
  });
});
