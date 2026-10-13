"use client";

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";

/** Browser side of the ceremonies. Same-origin fetches only (CSP connect-src 'self'). */
async function post<T>(url: string, body: unknown, csrf?: string): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `request failed (${String(res.status)})`);
  return data;
}

export function explain(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "NotAllowedError") return "The security key request was cancelled or timed out.";
    if (e.name === "InvalidStateError") return "This security key is already registered.";
    return e.message;
  }
  return "Something went wrong.";
}

export async function signIn(next: string | null): Promise<string> {
  const { options } = await post<{ options: PublicKeyCredentialRequestOptionsJSON }>("/api/auth/login/options", {});
  const response = await startAuthentication({ optionsJSON: options });
  const r = await post<{ next: string }>("/api/auth/login/verify", { response, next });
  return r.next;
}

export async function enrolOptions(token: string) {
  return post<{ options: PublicKeyCredentialCreationOptionsJSON; officer: { handle: string; name: string } }>("/api/auth/enrol/options", {
    token,
  });
}

export async function enrol(token: string, options: PublicKeyCredentialCreationOptionsJSON): Promise<void> {
  const response = await startRegistration({ optionsJSON: options });
  await post("/api/auth/enrol/verify", { token, response });
}

/** Fresh assertion on the current session (required within 5 minutes before any approval). */
export async function stepUp(csrf: string): Promise<string | null> {
  const { options } = await post<{ options: PublicKeyCredentialRequestOptionsJSON }>("/api/auth/stepup/options", {}, csrf);
  const response = await startAuthentication({ optionsJSON: options });
  const r = await post<{ stepUpAt: string | null }>("/api/auth/stepup/verify", { response }, csrf);
  return r.stepUpAt;
}
