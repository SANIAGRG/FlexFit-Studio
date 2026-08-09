import { appRouter } from "@/server/routers/_app";
import type { User } from "@/db/schema";
import type { TestDb } from "./db";

/**
 * Builds a tRPC caller directly against a test db, bypassing HTTP entirely.
 * `createContext()` in src/server/trpc.ts calls `cookies()` from
 * `next/headers`, which throws outside a real Next.js request — but every
 * router only ever reads `ctx.db` / `ctx.user` / `ctx.token`, so constructing
 * that object by hand is a faithful substitute, not a workaround.
 */
export function createTestCaller(db: TestDb, user: User | null = null) {
  return appRouter.createCaller({ db, user, token: user ? "test-token" : undefined });
}
