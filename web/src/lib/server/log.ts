/**
 * Minimal server-side error log for operations (stderr). Only a context label, the error class and
 * a shortened message: never request bodies, keys, CNICs or session values. Production uses the
 * backend's structured logger (pino, with redaction) and central log collection.
 */
export function logError(context: string, e: unknown): void {
  const name = e instanceof Error ? e.name : "Error";
  const message = (e instanceof Error ? e.message : String(e))
    .replace(/0x[0-9a-fA-F]{64,}/g, (h) => `${h.slice(0, 10)}…`) // shorten signatures/raw transactions
    .replace(/\s+/g, " ")
    .slice(0, 300);
  process.stderr.write(`${new Date().toISOString()} ERROR [${context}] ${name}: ${message}\n`);
}
