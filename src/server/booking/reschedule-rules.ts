import { and, eq, sql } from "drizzle-orm";
import { bookings, classes, type Booking, type GymClass } from "@/db/schema";
import type { db as Db } from "@/db";
import { hoursUntil } from "./time";
import { FREE_RESCHEDULE_HOURS } from "./constants";
import { countIndividualBooked } from "./capacity";

type RescheduleFailure = {
  ok: false;
  code: "NOT_FOUND" | "FORBIDDEN" | "BAD_REQUEST" | "CONFLICT";
  reason: string;
};

type RescheduleSuccess = {
  ok: true;
  originalBooking: Booking;
  originalClass: GymClass;
  targetClass: GymClass;
  targetIsFull: boolean;
};

export type RescheduleResult = RescheduleFailure | RescheduleSuccess;

/**
 * The ~11-step validation ladder shared by `reschedules.reschedule` (the
 * mutation) and `reschedules.validateReschedule` (the read-only preview).
 * One function, one order of checks, one set of message strings — the two
 * callers map this same result to their own output shape (throw vs. return)
 * instead of each re-implementing the ladder. Does not check membership
 * status: neither original caller did, and preserving that gap (not fixing
 * it) is deliberate — see documents/known-issues.md #4.
 */
export async function evaluateReschedule(
  db: typeof Db,
  userId: number,
  input: { fromBookingId: number; toClassId: number },
): Promise<RescheduleResult> {
  const originalRow = await db
    .select({ booking: bookings, cls: classes })
    .from(bookings)
    .innerJoin(classes, eq(bookings.classId, classes.id))
    .where(eq(bookings.id, input.fromBookingId))
    .get();

  if (!originalRow) {
    return { ok: false, code: "NOT_FOUND", reason: "Booking not found." };
  }

  const originalBooking = originalRow.booking;
  const originalClass = originalRow.cls;

  if (originalBooking.userId !== userId) {
    return {
      ok: false,
      code: "FORBIDDEN",
      reason: "You cannot reschedule this booking.",
    };
  }

  if (originalBooking.status !== "booked" && originalBooking.status !== "waitlisted") {
    return {
      ok: false,
      code: "BAD_REQUEST",
      reason: "This booking is no longer active.",
    };
  }

  const hoursBeforeOriginal = hoursUntil(originalClass.startsAt);
  if (hoursBeforeOriginal < FREE_RESCHEDULE_HOURS) {
    return {
      ok: false,
      code: "BAD_REQUEST",
      reason: `You can only reschedule up to ${FREE_RESCHEDULE_HOURS} hours before the class starts.`,
    };
  }

  const targetClass = await db.select().from(classes).where(eq(classes.id, input.toClassId)).get();

  if (!targetClass) {
    return { ok: false, code: "NOT_FOUND", reason: "Target class not found." };
  }

  if (targetClass.name !== originalClass.name) {
    return {
      ok: false,
      code: "BAD_REQUEST",
      reason: "You can only reschedule to a class with the same name.",
    };
  }

  if (targetClass.id === originalClass.id) {
    return {
      ok: false,
      code: "BAD_REQUEST",
      reason: "You are already booked for this class.",
    };
  }

  if (hoursUntil(targetClass.startsAt) <= 0) {
    return {
      ok: false,
      code: "BAD_REQUEST",
      reason: "This class has already started.",
    };
  }

  if (targetClass.cancelled) {
    return {
      ok: false,
      code: "BAD_REQUEST",
      reason: "This class has been cancelled.",
    };
  }

  const existingBooking = await db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.classId, targetClass.id),
        eq(bookings.userId, userId),
        sql`${bookings.status} in ('booked', 'waitlisted')`,
      ),
    )
    .get();

  if (existingBooking) {
    return {
      ok: false,
      code: "CONFLICT",
      reason: "You already have an active booking for this class.",
    };
  }

  const targetIsFull = (await countIndividualBooked(db, targetClass.id)) >= targetClass.capacity;

  return { ok: true, originalBooking, originalClass, targetClass, targetIsFull };
}
