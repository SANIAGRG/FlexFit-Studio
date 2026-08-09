import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDb } from "./helpers/db";
import { createTestCaller } from "./helpers/caller";
import { makeUser, makeMembership, makeClass } from "./helpers/fixtures";

describe("test harness", () => {
  let db: TestDb;
  let close: () => void;

  beforeAll(() => {
    const testDb = createTestDb();
    db = testDb.db;
    close = testDb.close;
  });

  afterAll(() => close());

  it("applies the real schema to a throwaway db", async () => {
    const user = await makeUser(db, { role: "member" });
    expect(user.id).toBeGreaterThan(0);
  });

  it("drives a real router through createCaller with no HTTP", async () => {
    const member = await makeUser(db, { role: "member" });
    await makeMembership(db, member.id, { creditsRemaining: 5 });
    const cls = await makeClass(db, { capacity: 10, creditCost: 1 });

    const caller = createTestCaller(db, member);
    const booking = await caller.bookings.book({ classId: cls.id });

    expect(booking.status).toBe("booked");
    expect(booking.creditsUsed).toBe(1);
  });
});
