import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDb } from "./helpers/db";
import { createTestCaller } from "./helpers/caller";
import { makeUser, makeClass, fillClassBookings } from "./helpers/fixtures";

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
      "reports each class's own booked count, not a value shared across every row " +
        "(regression test for known-issues.md #9 — a correlated-subquery bug " +
        "that made every class report an identical, wrong count)",
      async () => {
        // Was previously a raw sql subquery whose column references rendered
        // unqualified (single-table outer scope), so the WHERE clause
        // resolved entirely inside the subquery's own `bookings` scope
        // (`bookings.class_id = bookings.id`) and never referenced the outer
        // class row at all — every class reported the same fixed value.
        // Fixed via a leftJoin + groupBy aggregate instead, which has no
        // correlated subquery left to mis-qualify.
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

        expect(withBookingsRow?.booked).toBe(3);
        expect(withoutBookingsRow?.booked).toBe(0);
      },
    );

    it("returns exactly `limit` classes, correctly aggregated, even when one has many bookings", async () => {
      // Guards against a leftJoin + groupBy regressing into counting
      // pre-aggregation join rows instead of distinct classes.
      const busyClass = await makeClass(db, { capacity: 30 });
      await fillClassBookings(db, busyClass, 12);

      const admin = await makeUser(db, { role: "admin" });
      const rows = await createTestCaller(db, admin).admin.classUtilisation({
        limit: 3,
      });

      expect(rows).toHaveLength(3);
      const busyRow = rows.find((r) => r.id === busyClass.id);
      if (busyRow) {
        expect(busyRow.booked).toBe(12);
      }
    });
  });
});
