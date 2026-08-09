import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDb } from "./helpers/db";
import { createTestCaller } from "./helpers/caller";
import {
  makeUser,
  makeClass,
  makeCompany,
  linkCompanyMember,
  fillClassBookings,
  fillCorporateBookings,
} from "./helpers/fixtures";
import {
  companies as companiesTable,
  corporateBookings as corporateBookingsTable,
  checkins as checkinsTable,
} from "@/db/schema";
import { eq } from "drizzle-orm";

describe("corporateBookings router", () => {
  let db: TestDb;
  let close: () => void;

  beforeAll(() => {
    const testDb = createTestDb();
    db = testDb.db;
    close = testDb.close;
  });

  afterAll(() => close());

  describe("book", () => {
    it("charges the company credit pool and confirms the seat when there's room", async () => {
      const company = await makeCompany(db, { creditPoolBalance: 20 });
      const member = await makeUser(db);
      await linkCompanyMember(db, member.id, company.id);
      const cls = await makeClass(db, { capacity: 10, creditCost: 3 });

      const booking = await createTestCaller(db, member).corporateBookings.book({
        classId: cls.id,
      });

      expect(booking.status).toBe("booked");
      expect(booking.creditsUsed).toBe(3);

      const updatedCompany = await db
        .select()
        .from(companiesTable)
        .where(eq(companiesTable.id, company.id))
        .get();
      expect(updatedCompany?.creditPoolBalance).toBe(17);
    });

    it("rejects a member not linked to any active company", async () => {
      const member = await makeUser(db);
      const cls = await makeClass(db, { capacity: 10 });

      await expect(
        createTestCaller(db, member).corporateBookings.book({ classId: cls.id }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "You are not linked to an active company.",
      });
    });

    it("rejects when the company pool can't cover the class cost", async () => {
      const company = await makeCompany(db, { creditPoolBalance: 1 });
      const member = await makeUser(db);
      await linkCompanyMember(db, member.id, company.id);
      const cls = await makeClass(db, { creditCost: 2 });

      await expect(
        createTestCaller(db, member).corporateBookings.book({ classId: cls.id }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "Your company does not have enough credits.",
      });
    });

    it("ignores an active company link when the company itself is inactive", async () => {
      const company = await makeCompany(db, { creditPoolBalance: 20, active: false });
      const member = await makeUser(db);
      await linkCompanyMember(db, member.id, company.id);
      const cls = await makeClass(db, { capacity: 10 });

      await expect(
        createTestCaller(db, member).corporateBookings.book({ classId: cls.id }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "You are not linked to an active company.",
      });
    });

    it("waitlists once corporateBookings alone reach capacity, independent of individual bookings", async () => {
      const cls = await makeClass(db, { capacity: 1, creditCost: 1 });
      const company = await makeCompany(db, { creditPoolBalance: 20 });
      await fillCorporateBookings(db, cls, company.id, 1);

      const member = await makeUser(db);
      await linkCompanyMember(db, member.id, company.id);
      const booking = await createTestCaller(db, member).corporateBookings.book({
        classId: cls.id,
      });

      expect(booking.status).toBe("waitlisted");
      expect(booking.creditsUsed).toBe(0);
    });

    it(
      "split-brain: individual and corporate bookings each fill capacity independently, " +
        "so a 1-seat room can hold one of each and neither side sees itself as full",
      async () => {
        const cls = await makeClass(db, { capacity: 1, creditCost: 1 });

        // Individual side fills its own count of the room to capacity.
        await fillClassBookings(db, cls, 1);

        // Corporate side is entirely unaware of that — it only counts corporateBookings.
        const company = await makeCompany(db, { creditPoolBalance: 20 });
        const corporateMember = await makeUser(db);
        await linkCompanyMember(db, corporateMember.id, company.id);
        const corporateBooking = await createTestCaller(
          db,
          corporateMember,
        ).corporateBookings.book({ classId: cls.id });

        // Room has capacity 1 but now holds 2 confirmed occupants across the two tables.
        expect(corporateBooking.status).toBe("booked");

        const bookedCount = await db
          .select()
          .from(corporateBookingsTable)
          .where(eq(corporateBookingsTable.classId, cls.id));
        expect(bookedCount.filter((b) => b.status === "booked")).toHaveLength(1);
      },
    );
  });

  describe("cancel", () => {
    it("refunds the pool when cancelling >= 24h before class start", async () => {
      const company = await makeCompany(db, { creditPoolBalance: 20 });
      const member = await makeUser(db);
      await linkCompanyMember(db, member.id, company.id);
      const cls = await makeClass(db, { hoursFromNow: 30, creditCost: 2 });
      const caller = createTestCaller(db, member);
      const booking = await caller.corporateBookings.book({ classId: cls.id });

      const result = await caller.corporateBookings.cancel({ bookingId: booking.id });
      expect(result).toEqual({ ok: true, refunded: true });

      const updated = await db
        .select()
        .from(companiesTable)
        .where(eq(companiesTable.id, company.id))
        .get();
      expect(updated?.creditPoolBalance).toBe(20);
    });

    it("does not refund the pool when cancelling < 24h before class start (double the individual window)", async () => {
      const company = await makeCompany(db, { creditPoolBalance: 20 });
      const member = await makeUser(db);
      await linkCompanyMember(db, member.id, company.id);
      const cls = await makeClass(db, { hoursFromNow: 20, creditCost: 2 });
      const caller = createTestCaller(db, member);
      const booking = await caller.corporateBookings.book({ classId: cls.id });

      const result = await caller.corporateBookings.cancel({ bookingId: booking.id });
      expect(result).toEqual({ ok: true, refunded: false });

      const updated = await db
        .select()
        .from(companiesTable)
        .where(eq(companiesTable.id, company.id))
        .get();
      expect(updated?.creditPoolBalance).toBe(18);
    });

    it(
      "promotes a waitlisted corporate booking even when the pool can't afford it, " +
        "but (unlike the individual side) skips the ledger deduction in that case (known-issues.md #1)",
      async () => {
        // book()'s own credit check means a company can never *reach* a
        // waitlisted state through the router while under-funded for that
        // class — the realistic path is affording it at waitlist time, then
        // the pool being spent elsewhere before promotion runs. Reproduce
        // that end state directly, same technique as the equivalent
        // individual-booking test.
        // hoursFromNow: 20 keeps the class inside the 24h corporate
        // cancellation window, so cancelling `first` below does NOT refund
        // the pool — that's what leaves the pool at 0 for promotion to face.
        const cls = await makeClass(db, { capacity: 1, creditCost: 5, hoursFromNow: 20 });
        const company = await makeCompany(db, { creditPoolBalance: 5 });

        const first = await makeUser(db);
        await linkCompanyMember(db, first.id, company.id);
        const firstBooking = await createTestCaller(db, first).corporateBookings.book({
          classId: cls.id,
        });
        // Pool is now 0 (fully spent by `first`'s booking).

        const second = await makeUser(db);
        await linkCompanyMember(db, second.id, company.id);
        const waitlistedRow = await db
          .insert(corporateBookingsTable)
          .values({
            classId: cls.id,
            userId: second.id,
            companyId: company.id,
            status: "waitlisted",
            creditsUsed: 0,
          })
          .returning()
          .get();

        await createTestCaller(db, first).corporateBookings.cancel({
          bookingId: firstBooking.id,
        });

        const promoted = await db
          .select()
          .from(corporateBookingsTable)
          .where(eq(corporateBookingsTable.id, waitlistedRow.id))
          .get();
        // Promotion happens regardless of affordability...
        expect(promoted?.status).toBe("booked");
        expect(promoted?.creditsUsed).toBe(5);

        const updatedCompany = await db
          .select()
          .from(companiesTable)
          .where(eq(companiesTable.id, company.id))
          .get();
        // ...but the pool is never actually charged for it, because the
        // guard `if (company.creditPoolBalance >= creditCost)` fails at 0 >= 5.
        // The booking row claims a cost the ledger never paid.
        expect(updatedCompany?.creditPoolBalance).toBe(0);
      },
    );
  });

  describe("markAttended", () => {
    it(
      "records a checkin with bookingId null and ignores the source input " +
        "(known-issues.md #5 — corporate checkins are never counted anywhere)",
      async () => {
        const company = await makeCompany(db, { creditPoolBalance: 20 });
        const member = await makeUser(db);
        await linkCompanyMember(db, member.id, company.id);
        const cls = await makeClass(db, { hoursFromNow: 48 });
        const booking = await createTestCaller(db, member).corporateBookings.book({
          classId: cls.id,
        });

        const staff = await makeUser(db, { role: "admin" });
        await createTestCaller(db, staff).corporateBookings.markAttended({
          bookingId: booking.id,
          source: "kiosk",
        });

        const checkinRows = await db
          .select()
          .from(checkinsTable)
          .where(eq(checkinsTable.userId, member.id));
        expect(checkinRows).toHaveLength(1);
        expect(checkinRows[0].bookingId).toBeNull();
        expect(checkinRows[0].source).toBe("front_desk"); // "kiosk" was passed in and silently dropped
      },
    );
  });
});
