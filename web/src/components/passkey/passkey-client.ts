"use client";

import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import {
  passkeyLoginOptions,
  passkeyLoginVerify,
  passkeyRegisterOptions,
  passkeyRegisterVerify,
  passkeyStepUpOptions,
  passkeyStepUpVerify,
} from "@/app/actions/passkey";
import type { PasskeyError } from "@/lib/passkey-rules";

/**
 * Browser side of the investor passkey ceremonies (T-030): the server actions hand out options and
 * check the responses; @simplewebauthn/browser talks to the authenticator. Same-origin only.
 */
export class PasskeyFailure extends Error {
  constructor(readonly key: PasskeyError) {
    super(key);
  }
}

function fail(r: { error: PasskeyError } | object): never | void {
  if ("error" in r) throw new PasskeyFailure(r.error);
}

/** Maps any failure (ours or the browser's) to a message key. */
export function errorKey(e: unknown): PasskeyError {
  if (e instanceof PasskeyFailure) return e.key;
  if (e instanceof Error) {
    if (e.name === "NotAllowedError" || e.name === "AbortError") return "cancelled";
    if (e.name === "InvalidStateError") return "duplicate";
    if (e.name === "NotSupportedError") return "unsupported";
  }
  return "generic";
}

export function supported(): boolean {
  return browserSupportsWebAuthn();
}

export async function signInWithPasskey(): Promise<string> {
  const o = await passkeyLoginOptions();
  if ("error" in o) throw new PasskeyFailure(o.error);
  const response = await startAuthentication({ optionsJSON: o.options });
  const r = await passkeyLoginVerify(response);
  if ("error" in r) throw new PasskeyFailure(r.error);
  return r.next;
}

export async function stepUpWithPasskey(): Promise<void> {
  const o = await passkeyStepUpOptions();
  if ("error" in o) throw new PasskeyFailure(o.error);
  const response = await startAuthentication({ optionsJSON: o.options });
  fail(await passkeyStepUpVerify(response));
}

/** Registers a passkey; an investor who already has one confirms with it first (then this retries once). */
export async function registerPasskey(name: string): Promise<void> {
  let o = await passkeyRegisterOptions(name);
  if ("error" in o && o.error === "reauthStepUp") {
    await stepUpWithPasskey();
    o = await passkeyRegisterOptions(name);
  }
  if ("error" in o) throw new PasskeyFailure(o.error);
  const response = await startRegistration({ optionsJSON: o.options });
  fail(await passkeyRegisterVerify(response, name));
}
