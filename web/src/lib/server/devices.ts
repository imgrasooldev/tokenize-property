import { db } from "./db";

/**
 * Linking the mobile app (ADR 0018, migration 0058): the investor approves the code the app shows
 * (OAuth 2.0 Device Authorization Grant, RFC 8628) and sees or removes linked devices. The database
 * decides (papi.web_device_*): a live session, a passkey step-up where the investor has a passkey.
 */
export type DeviceDecision = { ok: true; deviceName: string } | { error: "stepup" | "enrolPasskey" | "code" | "session" | "input" };

export async function lookupDevice(session: Buffer, code: string): Promise<{ deviceName: string; expiresAt: string } | null> {
  const { rows } = await (await db()).query<{ r: { deviceName: string; expiresAt: string } | null }>("SELECT papi.web_device_lookup($1, $2) AS r", [session, code]);
  return rows[0]?.r ?? null;
}

export async function decideDevice(session: Buffer, code: string, decision: "approve" | "deny"): Promise<DeviceDecision> {
  const { rows } = await (await db()).query<{ r: { ok?: boolean; deviceName?: string; error?: string } }>("SELECT papi.web_device_decide($1, $2, $3) AS r", [
    session,
    code,
    decision,
  ]);
  const r = rows[0]?.r;
  if (r?.ok) return { ok: true, deviceName: r.deviceName ?? "" };
  if (r?.error === "step_up") return { error: "stepup" };
  if (r?.error === "enrol") return { error: "enrolPasskey" };
  if (r?.error === "code" || r?.error === "input") return { error: r.error };
  return { error: "session" };
}

export interface LinkedDevice {
  family: string;
  device_name: string;
  linked_at: Date;
  last_used_at: Date;
}

export async function linkedDevices(session: Buffer): Promise<LinkedDevice[]> {
  const { rows } = await (await db()).query<LinkedDevice>("SELECT family, device_name, linked_at, last_used_at FROM papi.web_devices($1)", [session]);
  return rows;
}

export async function removeDevice(session: Buffer, family: string): Promise<boolean> {
  const { rows } = await (await db()).query<{ ok: boolean }>("SELECT papi.web_device_remove($1, $2) AS ok", [session, family]);
  return rows[0]?.ok === true;
}
