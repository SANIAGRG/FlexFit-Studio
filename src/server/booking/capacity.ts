import { and, eq, sql } from "drizzle-orm";
import { bookings, corporateBookings } from "@/db/schema";
import type { db as Db } from "@/db";

/**
 * Confirmed (status "booked") individual seats held for a class.
 *
 * Deliberately separate from countCorporateBooked below, and not summed
 * with it anywhere. Individual and corporate bookings live in different
 * tables and are, today, counted against capacity independently — a class
 * can hold `capacity` individual bookings AND `capacity` corporate bookings
 * at once. That's a pre-existing split-brain, not something this extraction
 * introduces or should paper over. See documents/architecture-decisions.md
 * and documents/known-issues.md for the full reasoning; merging these two
 * counts would be a behavior change, not a refactor.
 */
export async function countIndividualBooked(db: typeof Db, classId: number): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(bookings)
    .where(and(eq(bookings.classId, classId), eq(bookings.status, "booked")));
  return Number(count);
}

/** Confirmed (status "booked") corporate seats held for a class. See countIndividualBooked. */
export async function countCorporateBooked(db: typeof Db, classId: number): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(corporateBookings)
    .where(and(eq(corporateBookings.classId, classId), eq(corporateBookings.status, "booked")));
  return Number(count);
}
