import { createHash } from "node:crypto";
import type { Locale } from "./events.ts";

/**
 * Delivery providers (ADR 0013). SMS and e-mail now; push comes with the investor app (T-040).
 * Real SMS gateways and e-mail services are task T-031; until then only the mocks below exist.
 *
 * Contract every adapter must keep (the worker's exactly-once argument depends on it):
 *  - `send` passes `idempotencyKey` to the provider where the provider supports one, and honours
 *    the AbortSignal (the worker aborts after its send timeout).
 *  - Throw `ProviderRejected` only when the provider definitively refused the message (invalid
 *    number, blocked address): it will never be delivered, so the worker does not retry.
 *  - Throw `ProviderUnavailable` only when the request PROVABLY did not reach the provider (for
 *    example connection refused before anything was written). The worker retries it.
 *  - Anything else (timeouts, resets, 5xx after the request was sent) is "outcome unknown": the
 *    worker never retries it blindly; it asks `lookup` after the lease has expired.
 *  - `lookup(idempotencyKey)` must be authoritative once the send call has ended: "accepted" with
 *    the provider's message id, "not_found" only if the provider never accepted that key, or
 *    "unknown" if it cannot tell (the worker then waits and finally dead-letters the delivery).
 */

export interface OutboundMessage {
  /** The delivery's uid: identical on every attempt for the same delivery. */
  idempotencyKey: string;
  channel: "sms" | "email";
  /** Plain phone number (E.164) or e-mail address; opened in memory only for this call. */
  to: string;
  locale: Locale;
  subject?: string;
  text: string;
  html?: string;
}

export type LookupResult = { state: "accepted"; messageId: string } | { state: "not_found" } | { state: "unknown" };

export interface Provider {
  /** Recorded with each delivery, e.g. "mock-sms". Lower case, 2-32 characters. */
  readonly name: string;
  readonly channel: "sms" | "email";
  send(message: OutboundMessage, signal: AbortSignal): Promise<{ messageId: string }>;
  lookup(idempotencyKey: string): Promise<LookupResult>;
}

/** The provider refused the message for good; it will never be delivered. */
export class ProviderRejected extends Error {
  override name = "ProviderRejected";
}

/** The request provably never reached the provider; safe to retry. */
export class ProviderUnavailable extends Error {
  override name = "ProviderUnavailable";
}

/**
 * Faults a mock can simulate on one send call:
 *  ok                 accepted
 *  unavailable        not accepted, throws ProviderUnavailable
 *  reject             not accepted, throws ProviderRejected
 *  error_before       not accepted, throws a plain Error (outcome unknown to the worker)
 *  accept_then_error  ACCEPTED, then throws a plain Error (a crash or timeout after the provider
 *                     took the message and before the worker recorded it)
 *  hang               never answers until the worker aborts (not accepted)
 */
export type SendFault = "ok" | "unavailable" | "reject" | "error_before" | "accept_then_error" | "hang";
export type LookupFault = "ok" | "unknown" | "error";

export interface MockProviderOptions {
  name?: string;
  /**
   * true: like a provider with idempotency keys, a repeated key returns the first message id
   * without sending again. false (worst case, used by the property test): every accepted call
   * is a new message, so only the worker's discipline prevents duplicates.
   */
  dedupe?: boolean;
  /** Deterministic fault per call (n = 1-based call number for this mock). */
  sendFault?: (message: OutboundMessage, n: number) => SendFault;
  lookupFault?: (idempotencyKey: string, n: number) => LookupFault;
  /** Called for every accepted message (e.g. the CLI prints a redacted line). */
  onAccept?: (record: MockRecord) => void;
}

export interface MockRecord {
  messageId: string;
  idempotencyKey: string;
  to: string;
  subject?: string;
  text: string;
  html?: string;
  locale: Locale;
}

/** Records what would be sent; never contacts anyone. */
export class MockProvider implements Provider {
  readonly name: string;
  readonly sent: MockRecord[] = [];
  private sends = 0;
  private lookups = 0;
  private readonly byKey = new Map<string, MockRecord>();

  constructor(
    readonly channel: "sms" | "email",
    private readonly opts: MockProviderOptions = {},
  ) {
    this.name = opts.name ?? `mock-${channel}`;
  }

  /** How many times the provider accepted this key (the property test's "at most once"). */
  acceptances(idempotencyKey: string): number {
    return this.sent.filter((r) => r.idempotencyKey === idempotencyKey).length;
  }

  async send(message: OutboundMessage, signal: AbortSignal): Promise<{ messageId: string }> {
    const n = ++this.sends;
    if (message.channel !== this.channel) throw new ProviderRejected(`${this.name} sends ${this.channel} only`);
    const fault = this.opts.sendFault?.(message, n) ?? "ok";
    await Promise.resolve();
    if (signal.aborted) throw new Error("aborted");
    switch (fault) {
      case "unavailable":
        throw new ProviderUnavailable(`${this.name}: connection refused (simulated)`);
      case "reject":
        throw new ProviderRejected(`${this.name}: recipient refused (simulated)`);
      case "error_before":
        throw new Error(`${this.name}: connection reset before the request was read (simulated)`);
      case "hang":
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new Error(`${this.name}: aborted after timeout (simulated)`));
          });
        });
      case "ok":
      case "accept_then_error": {
        const record = this.accept(message);
        if (fault === "accept_then_error") throw new Error(`${this.name}: timed out after the provider accepted (simulated)`);
        return { messageId: record.messageId };
      }
    }
  }

  lookup(idempotencyKey: string): Promise<LookupResult> {
    const n = ++this.lookups;
    const fault = this.opts.lookupFault?.(idempotencyKey, n) ?? "ok";
    if (fault === "error") return Promise.reject(new Error(`${this.name}: lookup failed (simulated)`));
    if (fault === "unknown") return Promise.resolve({ state: "unknown" });
    const r = this.byKey.get(idempotencyKey);
    return Promise.resolve(r ? { state: "accepted", messageId: r.messageId } : { state: "not_found" });
  }

  private accept(message: OutboundMessage): MockRecord {
    const existing = this.byKey.get(message.idempotencyKey);
    if (existing && this.opts.dedupe !== false) return existing;
    const seq = this.sent.length + 1;
    const messageId = `${this.name}-${createHash("sha256").update(`${message.idempotencyKey}#${String(seq)}`).digest("hex").slice(0, 20)}`;
    const record: MockRecord = {
      messageId,
      idempotencyKey: message.idempotencyKey,
      to: message.to,
      text: message.text,
      locale: message.locale,
      ...(message.subject === undefined ? {} : { subject: message.subject }),
      ...(message.html === undefined ? {} : { html: message.html }),
    };
    this.sent.push(record);
    if (!existing) this.byKey.set(message.idempotencyKey, record);
    this.opts.onAccept?.(record);
    return record;
  }
}
