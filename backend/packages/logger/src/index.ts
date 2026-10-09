import { pino, type DestinationStream, type Logger } from "pino";

/**
 * Fields that must never reach a log line (threats K-6, D-2, API-7). Matching is by key name at
 * any of the listed depths; values are replaced with "[REDACTED]".
 */
export const REDACTED_KEYS = [
  "password",
  "passwd",
  "secret",
  "token",
  "authorization",
  "cookie",
  "privateKey",
  "private_key",
  "mnemonic",
  "seed",
  "apiKey",
  "cnic",
  "iban",
  "accountNumber",
  "PG_PASSWORD",
] as const;

const paths = REDACTED_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`, `headers.${k}`, `req.headers.${k}`]);

export interface LoggerOptions {
  service: string;
  level?: string;
  /** For tests: write somewhere other than stdout. */
  destination?: DestinationStream;
}

export function createLogger({ service, level = "info", destination }: LoggerOptions): Logger {
  const options = {
    level,
    base: { service },
    redact: { paths, censor: "[REDACTED]" },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination ? pino(options, destination) : pino(options);
}

export type { Logger };
