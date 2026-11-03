import pg from "pg";

/**
 * Vitest setup file (tests only). pg.Pool.query() closes its connection after ANY error, and a new
 * PostgreSQL connection costs ~100 ms on Windows (a process per backend, SCRAM). Many tests expect
 * refusals, so in tests a pool keeps the connection after an ordinary SQL error and drops it only
 * after a connection error (class 08 or 57P, or no SQLSTATE). Calls with a callback are unchanged.
 */
type Query = (this: pg.Pool, ...args: unknown[]) => unknown;
const original = Reflect.get(pg.Pool.prototype, "query") as Query;

function connectionError(e: unknown): boolean {
  const code = (e as { code?: unknown }).code;
  return typeof code !== "string" || /^(08|57P)/.test(code);
}

const keeping: Query = function (this: pg.Pool, ...args: unknown[]) {
  if (typeof args[args.length - 1] === "function") return original.apply(this, args);
  return (async () => {
    const client = await this.connect();
    try {
      const result: unknown = await (client.query as unknown as (...a: unknown[]) => Promise<unknown>).apply(client, args);
      client.release();
      return result;
    } catch (e) {
      client.release(connectionError(e) ? (e as Error) : undefined);
      throw e;
    }
  })();
};

if (process.env.PT_KEEP_CONNECTIONS !== "0") pg.Pool.prototype.query = keeping as unknown as typeof pg.Pool.prototype.query;
