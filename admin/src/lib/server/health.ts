import { db } from "./db";

/**
 * Operations health and alerts (migration 0052, ops.read). One call of admin.health, which checks
 * the session and the permission itself. Details hold states, counts, ages and block numbers only.
 */

export interface HealthCheck {
  source: "database" | "server";
  check: string;
  level: "OK" | "WARN" | "CRIT" | "N/A";
  detail: string;
  since: string | null;
}

export interface HealthAlert {
  id: number;
  check: string;
  level: "WARN" | "CRIT";
  detail: string;
  openedAt: string;
  lastSeenAt: string;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  ackNote: string | null;
  resolvedAt: string | null;
}

export interface Health {
  at: string;
  checks: HealthCheck[];
  open: HealthAlert[];
  closed: HealthAlert[];
  reports: { host: string; at: string }[];
  settings: { key: string; value: number; description: string }[];
  canAcknowledge: boolean;
}

export async function health(sessionHash: Buffer): Promise<Health> {
  const { rows } = await db().query<{ v: Health | null }>("SELECT admin.health($1) AS v", [sessionHash]);
  const v = rows[0]?.v;
  if (!v) throw new Error("no health answer");
  return v;
}

/** Chip class for a check level. */
export function levelChip(level: string): string {
  if (level === "OK") return "chip ok";
  if (level === "CRIT") return "chip bad";
  if (level === "WARN") return "chip warn";
  return "chip";
}
