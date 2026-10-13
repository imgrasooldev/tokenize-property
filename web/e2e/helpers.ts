import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import pg from "pg";

/** SQL against the TEST database only (the e2e server uses property_token_test). */
export async function testDb<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const env = new Map<string, string>();
  // Fixed path inside the repository.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  for (const line of readFileSync(join(process.cwd(), "..", "backend", ".env.local"), "utf8").split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0 && !line.startsWith("#")) env.set(line.slice(0, eq), line.slice(eq + 1));
  }
  const client = new pg.Client({
    host: "127.0.0.1",
    port: Number(env.get("PG_PORT") ?? 5433),
    user: env.get("PG_ADMIN_USER") ?? "pt_admin",
    password: env.get("PG_ADMIN_PASSWORD") ?? "",
    database: "property_token_test",
  });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

export async function loginAs(page: Page, who: "Alice" | "Bob"): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByRole("button", { name: `Continue as ${who}` }).click();
  await expect(page).toHaveURL(/\/account$/);
}

/** A random CNIC the mock NADRA accepts: last digit 1-7 (0 = not found, 8 = name mismatch, 9 = unavailable). */
export function randomCnic(): string {
  const d = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");
  return `${d(5)}-${d(7)}-${String(1 + Math.floor(Math.random() * 7))}`;
}
