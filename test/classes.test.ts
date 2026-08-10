import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDb } from "./helpers/db";
import { createTestCaller } from "./helpers/caller";
import {
  makeUser,
  makeMembership,
  makeClass,
  makeCompany,
  linkCompanyMember,
  fillClassBookings,
} from "./helpers/fixtures";
import {
  memberships as membershipsTable,
  bookings as bookingsTable,
  corporateBookings as corporateBookingsTable,
  companies as companiesTable,
  notifications as notificationsTable,
} from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * Characterization tests, same discipline as bookings.test.ts /
 * reschedules.test.ts: these deliberately pin the current, known-buggy
 * behavior of `classes.cancel` (known-issues.md #10) — not the behavior a
 * fix would produce. Every assertion below is the *wrong* value (unrefunded
 * credits, an untouched waitlist row, an untouched corporate booking, zero
 * notifications). If #10 is ever fixed, these four tests are expected to go
 * red — that's the point: a red test here means "the fix changed this,"
 * not "the refactor broke something." Do not "fix" a failing assertion here
 * to match new output; update known-issues.md instead and treat the fix as
 * its own decision, the same way bug #9 was handled.
 *
 * Each `it` block creates its own class/user/company fixtures from scratch
 * (see test/helpers/fixtures.ts's `unique()` counter) — no fixture is shared
 * across tests, so these do not depend on run order within this file.
 */
describe("classes router", () => {
  let db: TestDb;
  let close: () => void;

  beforeAll(() => {
    const testDb = createTestDb();
    db = testDb.db;
    close = testDb.close;
  });

  afterAll(() => close());

  describe("documented bugs (known-issues.md)", () => {
    it("#10.1 — cancelling a class does not refund credits for members who had booked it", async () => {
      const member = await makeUser(db);
      const membership = await makeMembership(db, member.id, { creditsRemaining: 5 });
      const cls = await makeClass(db, { capacity: 10, creditCost: 2 });

      const memberCaller = createTestCaller(db, member);
      const booking = await memberCaller.bookings.book({ classId: cls.id });
      expect(booking.creditsUsed).toBe(2);

      const admin = await makeUser(db, { role: "admin" });
      await createTestCaller(db, admin).classes.cancel({ id: cls.id });

      const cancelledBooking = await db
        .select()
        .from(bookingsTable)
        .where(eq(bookingsTable.id, booking.id))
        .get();
      expect(cancelledBooking?.status).toBe("cancelled");

      const membershipAfter = await db
        .select()
        .from(membershipsTable)
        .where(eq(membershipsTable.id, membership.id))
        .get();
      // Credits stay spent even though the gym, not the member, cancelled.
      expect(membershipAfter?.creditsRemaining).toBe(3);
    });

    it("#10.2 — cancelling a class leaves waitlisted bookings untouched, still pointing at the now-cancelled class", async () => {
      const cls = await makeClass(db, { capacity: 1 });
      await fillClassBookings(db, cls, 1); // fills the one seat

      const waitlistedMember = await makeUser(db);
      await makeMembership(db, waitlistedMember.id, { creditsRemaining: 5 });
      const waitlistedBooking = await createTestCaller(db, waitlistedMember).bookings.book({
        classId: cls.id,
      });
      expect(waitlistedBooking.status).toBe("waitlisted");

      const admin = await makeUser(db, { role: "admin" });
      await createTestCaller(db, admin).classes.cancel({ id: cls.id });

      const stillWaitlisted = await db
        .select()
        .from(bookingsTable)
        .where(eq(bookingsTable.id, waitlistedBooking.id))
        .get();
      // Only `status = 'booked'` rows are touched by classes.cancel — this
      // row was 'waitlisted' and is never revisited.
      expect(stillWaitlisted?.status).toBe("waitlisted");
    });

    it("#10.3 — cancelling a class never touches corporateBookings; the corporate seat and pool charge remain in effect", async () => {
      const company = await makeCompany(db, { creditPoolBalance: 50 });
      const corporateMember = await makeUser(db);
      await linkCompanyMember(db, corporateMember.id, company.id);
      const cls = await makeClass(db, { capacity: 10, creditCost: 3 });

      const corporateBooking = await createTestCaller(db, corporateMember).corporateBookings.book(
        { classId: cls.id },
      );
      expect(corporateBooking.status).toBe("booked");

      const admin = await makeUser(db, { role: "admin" });
      await createTestCaller(db, admin).classes.cancel({ id: cls.id });

      const bookingAfter = await db
        .select()
        .from(corporateBookingsTable)
        .where(eq(corporateBookingsTable.id, corporateBooking.id))
        .get();
      expect(bookingAfter?.status).toBe("booked");

      const companyAfter = await db
        .select()
        .from(companiesTable)
        .where(eq(companiesTable.id, company.id))
        .get();
      // Pool was charged on booking and is never credited back.
      expect(companyAfter?.creditPoolBalance).toBe(47);
    });

    it("#10.4 — cancelling a class sends no notification to any affected member", async () => {
      const member = await makeUser(db);
      await makeMembership(db, member.id, { creditsRemaining: 5 });
      const cls = await makeClass(db, { capacity: 10 });
      await createTestCaller(db, member).bookings.book({ classId: cls.id });

      const admin = await makeUser(db, { role: "admin" });
      await createTestCaller(db, admin).classes.cancel({ id: cls.id });

      const memberNotifications = await db
        .select()
        .from(notificationsTable)
        .where(eq(notificationsTable.userId, member.id));
      expect(memberNotifications).toHaveLength(0);
    });
  });
});
