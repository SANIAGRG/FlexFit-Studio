import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "@/db/schema";

/**
 * Provisions a throwaway SQLite file and applies the real schema to it via
 * `drizzle-kit push`, the same mechanism `pnpm db:push` uses against
 * flexfit.db. Deliberately not `:memory:` — file mode is what @libsql/client
 * uses in production, and push is the real schema-application path rather
 * than a hand-maintained copy of it.
 */
export function createTestDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "flexfit-test-"));
  const dbFile = path.join(dir, "test.db");
  const url = `file:${dbFile}`;

  execSync("npx drizzle-kit push --force", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DB_FILE: url },
    stdio: "pipe",
  });

  const client: Client = createClient({ url });
  const db = drizzle(client, { schema });

  return {
    db,
    close() {
      client.close();
      // On Windows, the SQLite file handle isn't always released the instant
      // client.close() returns, so an immediate rmSync can hit EPERM. Retry
      // briefly rather than leak temp dirs silently or fail the test run over
      // teardown, which isn't the thing under test.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          return;
        } catch {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
      }
    },
  };
}

export type TestDb = ReturnType<typeof createTestDb>["db"];
