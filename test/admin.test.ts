import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDb } from "./helpers/db";
import { createTestCaller } from "./helpers/caller";
import { makeUser, makeClass, fillClassBookings } from "./helpers/fixtures";

/**
 * Characterization test: pins the CURRENT, WRONG behavior of
 * admin.classUtilisation before it is fixed. See documents/known-issues.md
 * bug #9. Do not "fix" this test to assert the correct values — its whole
 * purpose is to prove precisely what the buggy code did, so the fix commit
 * can flip these same assertions and make both the wrong and right numbers
 * visible in one diff.
 */
describe("admin router", () => {
  let db: TestDb;
  let close: () => void;

  beforeAll(() => {
    const testDb = createTestDb();
    db = testDb.db;
    close = testDb.close;
  });

  afterAll(() => close());

  describe("classUtilisation", () => {
    it(
      "BUG (known-issues.md #9): reports the same booked count for every class " +
        "regardless of how many bookings each one actually has",
      async () => {
        // Drizzle renders the subquery's column references unqualified when
        // the outer query has only one table in scope (no join present).
        // Inside the subquery's own `FROM bookings`, the bare "id" then binds
        // to bookings.id instead of the intended classes.id, so the WHERE
        // clause becomes `bookings.class_id = bookings.id` — a condition that
        // never references the outer class row at all. The reported count is
        // therefore identical for every class in the result set.
        const withBookings = await makeClass(db, { capacity: 10 });
        await fillClassBookings(db, withBookings, 3);

        const withoutBookings = await makeClass(db, { capacity: 10 });
        // deliberately zero bookings

        const admin = await makeUser(db, { role: "admin" });
        const rows = await createTestCaller(db, admin).admin.classUtilisation({
          limit: 50,
        });

        const withBookingsRow = rows.find((r) => r.id === withBookings.id);
        const withoutBookingsRow = rows.find((r) => r.id === withoutBookings.id);

        // The headline symptom: two classes with genuinely different booking
        // counts (3 vs. 0) report the identical "booked" value today.
        expect(withBookingsRow?.booked).toBe(withoutBookingsRow?.booked);

        // And it isn't coincidentally right for the class that does have
        // bookings — the reported value is not the real count of 3.
        expect(withBookingsRow?.booked).not.toBe(3);
      },
    );
  });
});
