import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDb } from "./helpers/db";
import { createTestCaller } from "./helpers/caller";
import { makeUser, makeMembership, makePayment } from "./helpers/fixtures";
import { memberships as membershipsTable } from "@/db/schema";
import { eq } from "drizzle-orm";

describe("payments router", () => {
  let db: TestDb;
  let close: () => void;

  beforeAll(() => {
    const testDb = createTestDb();
    db = testDb.db;
    close = testDb.close;
  });

  afterAll(() => close());

  describe("mine", () => {
    it("returns the caller's own payments with the plan name denormalized in, newest first", async () => {
      const member = await makeUser(db);
      const membership = await makeMembership(db, member.id);
      await makePayment(db, member.id, {
        membershipId: membership.id,
        amountCents: 50000,
        reference: "PAY-OLD",
      });
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await makePayment(db, member.id, {
        membershipId: membership.id,
        amountCents: 60000,
        reference: "PAY-NEW",
      });

      const rows = await createTestCaller(db, member).payments.mine();

      expect(rows).toHaveLength(2);
      expect(rows[0].reference).toBe("PAY-NEW"); // newest first
      expect(rows[1].reference).toBe("PAY-OLD");
      expect(rows[0].planName).toBeTruthy();
    }, 10000);

    it("does not return another member's payments", async () => {
      const member = await makeUser(db);
      const other = await makeUser(db);
      await makePayment(db, other.id);

      const rows = await createTestCaller(db, member).payments.mine();
      expect(rows).toHaveLength(0);
    });
  });

  describe("all", () => {
    it("is admin-only", async () => {
      const member = await makeUser(db);
      await expect(createTestCaller(db, member).payments.all()).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "Admins only.",
      });
    });

    it("lists payments across all members for admin, respecting the limit", async () => {
      const admin = await makeUser(db, { role: "admin" });
      const member = await makeUser(db);
      await makePayment(db, member.id);
      await makePayment(db, member.id);

      const rows = await createTestCaller(db, admin).payments.all({ limit: 1 });
      expect(rows).toHaveLength(1);
    });
  });

  describe("markPaid", () => {
    it("marks a pending payment as paid", async () => {
      const admin = await makeUser(db, { role: "admin" });
      const member = await makeUser(db);
      const payment = await makePayment(db, member.id, { status: "pending" });

      const updated = await createTestCaller(db, admin).payments.markPaid({
        id: payment.id,
      });
      expect(updated.status).toBe("paid");
    });

    it("rejects marking a refunded payment as paid", async () => {
      const admin = await makeUser(db, { role: "admin" });
      const member = await makeUser(db);
      const payment = await makePayment(db, member.id, { status: "refunded" });

      await expect(
        createTestCaller(db, admin).payments.markPaid({ id: payment.id }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "Refunded payments cannot be marked paid.",
      });
    });

    it("rejects a nonexistent payment", async () => {
      const admin = await makeUser(db, { role: "admin" });
      await expect(
        createTestCaller(db, admin).payments.markPaid({ id: 999_999 }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Payment not found." });
    });
  });

  describe("refund", () => {
    it("refunds a paid payment and cancels the linked membership", async () => {
      const admin = await makeUser(db, { role: "admin" });
      const member = await makeUser(db);
      const membership = await makeMembership(db, member.id, { status: "active" });
      const payment = await makePayment(db, member.id, {
        membershipId: membership.id,
        status: "paid",
      });

      const updated = await createTestCaller(db, admin).payments.refund({
        id: payment.id,
      });
      expect(updated.status).toBe("refunded");

      const updatedMembership = await db
        .select()
        .from(membershipsTable)
        .where(eq(membershipsTable.id, membership.id))
        .get();
      expect(updatedMembership?.status).toBe("cancelled");
    });

    it("refunds a paid payment with no membershipId without touching any membership", async () => {
      const admin = await makeUser(db, { role: "admin" });
      const member = await makeUser(db);
      const payment = await makePayment(db, member.id, { status: "paid", membershipId: null });

      const updated = await createTestCaller(db, admin).payments.refund({
        id: payment.id,
      });
      expect(updated.status).toBe("refunded");
    });

    it("rejects refunding a payment that isn't paid (pending)", async () => {
      const admin = await makeUser(db, { role: "admin" });
      const member = await makeUser(db);
      const payment = await makePayment(db, member.id, { status: "pending" });

      await expect(
        createTestCaller(db, admin).payments.refund({ id: payment.id }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "Only paid payments can be refunded.",
      });
    });

    it("rejects refunding an already-refunded payment", async () => {
      const admin = await makeUser(db, { role: "admin" });
      const member = await makeUser(db);
      const payment = await makePayment(db, member.id, { status: "refunded" });

      await expect(
        createTestCaller(db, admin).payments.refund({ id: payment.id }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "Only paid payments can be refunded.",
      });
    });

    it("is admin-only", async () => {
      const member = await makeUser(db);
      const payment = await makePayment(db, member.id, { status: "paid" });

      await expect(
        createTestCaller(db, member).payments.refund({ id: payment.id }),
      ).rejects.toMatchObject({ code: "FORBIDDEN", message: "Admins only." });
    });
  });
});
