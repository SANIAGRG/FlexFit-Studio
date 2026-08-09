import {
  users,
  membershipPlans,
  memberships,
  classes,
  companies,
  companyMembers,
  bookings,
  corporateBookings,
  payments,
  type User,
  type GymClass,
  type Membership,
  type Company,
  type Payment,
} from "@/db/schema";
import { hashPassword } from "@/lib/password";
import type { TestDb } from "./db";

let counter = 0;
function unique(prefix: string) {
  counter += 1;
  return `${prefix}${counter}`;
}

export async function makeUser(
  db: TestDb,
  overrides: Partial<typeof users.$inferInsert> = {},
): Promise<User> {
  return db
    .insert(users)
    .values({
      email: unique("user") + "@example.com",
      passwordHash: hashPassword("password123"),
      name: "Test User",
      role: "member",
      ...overrides,
    })
    .returning()
    .get();
}

export async function makePlan(
  db: TestDb,
  overrides: Partial<typeof membershipPlans.$inferInsert> = {},
) {
  return db
    .insert(membershipPlans)
    .values({
      name: unique("Plan"),
      priceCents: 100000,
      durationDays: 30,
      classCredits: 10,
      ...overrides,
    })
    .returning()
    .get();
}

/** Active membership, expiring `daysValid` from "now" (real wall-clock, not faked time). */
export async function makeMembership(
  db: TestDb,
  userId: number,
  overrides: Partial<typeof memberships.$inferInsert> & { daysValid?: number } = {},
): Promise<Membership> {
  const { daysValid = 30, ...rest } = overrides;
  const plan = rest.planId ? null : await makePlan(db);
  const start = new Date();
  const end = new Date(Date.now() + daysValid * 24 * 60 * 60 * 1000);
  return db
    .insert(memberships)
    .values({
      userId,
      planId: plan?.id ?? 0,
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
      creditsRemaining: 10,
      status: "active",
      ...rest,
    })
    .returning()
    .get();
}

/** A class starting `hoursFromNow` hours from real wall-clock time. */
export async function makeClass(
  db: TestDb,
  overrides: Partial<typeof classes.$inferInsert> & { hoursFromNow?: number } = {},
): Promise<GymClass> {
  const { hoursFromNow = 48, ...rest } = overrides;
  const startsAt = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString();
  return db
    .insert(classes)
    .values({
      name: unique("Class"),
      room: "Studio A",
      capacity: 10,
      startsAt,
      creditCost: 1,
      ...rest,
    })
    .returning()
    .get();
}

export async function makeCompany(
  db: TestDb,
  overrides: Partial<typeof companies.$inferInsert> = {},
): Promise<Company> {
  return db
    .insert(companies)
    .values({
      name: unique("Company"),
      contactEmail: "hr@example.com",
      creditPoolBalance: 50,
      active: true,
      ...overrides,
    })
    .returning()
    .get();
}

export async function linkCompanyMember(db: TestDb, userId: number, companyId: number) {
  return db.insert(companyMembers).values({ userId, companyId }).returning().get();
}

/** Fills a class to capacity with `booked` individual bookings from throwaway members. */
export async function fillClassBookings(db: TestDb, cls: GymClass, count: number) {
  for (let i = 0; i < count; i++) {
    const member = await makeUser(db);
    await db.insert(bookings).values({
      classId: cls.id,
      userId: member.id,
      status: "booked",
      creditsUsed: cls.creditCost,
    });
  }
}

export async function makePayment(
  db: TestDb,
  userId: number,
  overrides: Partial<typeof payments.$inferInsert> = {},
): Promise<Payment> {
  return db
    .insert(payments)
    .values({
      userId,
      amountCents: 100000,
      method: "card",
      status: "paid",
      ...overrides,
    })
    .returning()
    .get();
}

export async function fillCorporateBookings(
  db: TestDb,
  cls: GymClass,
  companyId: number,
  count: number,
) {
  for (let i = 0; i < count; i++) {
    const member = await makeUser(db);
    await db.insert(corporateBookings).values({
      classId: cls.id,
      userId: member.id,
      companyId,
      status: "booked",
      creditsUsed: cls.creditCost,
    });
  }
}
