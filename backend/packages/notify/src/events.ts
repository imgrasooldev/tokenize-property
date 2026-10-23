import { z } from "zod";

/**
 * Event catalogue (ADR 0013, rule N-2). Mirrors `notify.event_kinds` in migrations 0017, 0020 and 0030; a test
 * keeps the two identical. Every value a message can carry is one of these typed placeholders, so
 * no personal data (names, phone numbers, CNICs, IBANs, e-mail addresses) can reach a template.
 */

export type Channel = "sms" | "email" | "push";
export type Locale = "en" | "ur";
export type Category = "security" | "transactional" | "marketing";
export type PlaceholderType = "utc" | "paisa" | "count" | "last4" | "code" | "label" | "word";

interface PlaceholderSpec {
  readonly type: PlaceholderType;
  readonly choices?: readonly string[];
}

interface KindSpec {
  readonly category: Category;
  readonly placeholders: Readonly<Record<string, PlaceholderSpec>>;
}

export const EVENT_KINDS = {
  "security.new_device_sign_in": {
    category: "security",
    placeholders: { device: { type: "label" }, at: { type: "utc" } },
  },
  "security.contact_changed": {
    category: "security",
    placeholders: { channel: { type: "word", choices: ["sms", "email"] }, at: { type: "utc" } },
  },
  "security.payout_account_added": {
    category: "security",
    placeholders: { last4: { type: "last4" }, active_from: { type: "utc" } },
  },
  "security.payout_account_changed": {
    category: "security",
    placeholders: { last4: { type: "last4" }, previous_last4: { type: "last4" }, active_from: { type: "utc" } },
  },
  "security.payout_account_active": {
    category: "security",
    placeholders: { last4: { type: "last4" } },
  },
  "security.kyc_status_changed": {
    category: "security",
    placeholders: { status: { type: "word", choices: ["verified", "expired", "action_required", "closed"] } },
  },
  "security.account_frozen": {
    category: "security",
    placeholders: { at: { type: "utc" } },
  },
  "security.account_unfrozen": {
    category: "security",
    placeholders: { at: { type: "utc" } },
  },
  "security.large_transaction_pending": {
    category: "security",
    placeholders: { amount_paisa: { type: "paisa" }, reference: { type: "code" } },
  },
  // S-06 RC-2 (migration 0020): sent to the contacts of record when a wallet recovery is opened.
  "security.wallet_recovery_requested": {
    category: "security",
    placeholders: { at: { type: "utc" }, objection_until: { type: "utc" } },
  },
  // S-04 section 11 (migration 0028): the seller's contacts at every transfer request (account-takeover defence).
  "security.transfer_requested": {
    category: "security",
    placeholders: { at: { type: "utc" } },
  },
  // S-04 section 11 (migration 0028): both parties when a transfer changes state; the buyer's payment instructions.
  "transfer.status_changed": {
    category: "transactional",
    placeholders: {
      status: {
        type: "word",
        choices: ["accepted", "under_review", "not_approved", "approved", "payment_received", "on_chain", "transferred", "completed", "being_cancelled",
          "refund_pending", "refunded", "cancelled"],
      },
    },
  },
  "transfer.payment_due": {
    category: "transactional",
    placeholders: { amount_paisa: { type: "paisa" }, reference: { type: "code" }, expires_at: { type: "utc" } },
  },
  "offering.reservation_expiring": {
    category: "transactional",
    placeholders: { offering: { type: "code" }, amount_paisa: { type: "paisa" }, expires_at: { type: "utc" } },
  },
  "rent.paid": {
    category: "transactional",
    placeholders: { token: { type: "code" }, amount_paisa: { type: "paisa" }, period: { type: "code" } },
  },
  // Migration 0030 (producers, ADR 0013 amendment 1).
  "offering.reserved": {
    category: "transactional",
    placeholders: { offering: { type: "label" }, amount_paisa: { type: "paisa" }, expires_at: { type: "utc" } },
  },
  "offering.payment_received": {
    category: "transactional",
    placeholders: { offering: { type: "label" }, amount_paisa: { type: "paisa" } },
  },
  "offering.allocated": {
    category: "transactional",
    placeholders: { offering: { type: "label" }, units: { type: "count" } },
  },
  "offering.units_issued": {
    category: "transactional",
    placeholders: { offering: { type: "label" }, units: { type: "count" } },
  },
  "offering.reservation_expired": { category: "transactional", placeholders: { offering: { type: "label" } } },
  "offering.reservation_cancelled": { category: "transactional", placeholders: { offering: { type: "label" } } },
  "offering.waitlisted": { category: "transactional", placeholders: { offering: { type: "label" } } },
  "offering.not_accepted": { category: "transactional", placeholders: { offering: { type: "label" } } },
  "offering.refund_pending": {
    category: "transactional",
    placeholders: { offering: { type: "label" }, amount_paisa: { type: "paisa" } },
  },
  "offering.refunded": {
    category: "transactional",
    placeholders: { offering: { type: "label" }, amount_paisa: { type: "paisa" } },
  },
  "bank.payment_unmatched": {
    category: "transactional",
    placeholders: { amount_paisa: { type: "paisa" }, at: { type: "utc" } },
  },
  "rent.distributed": {
    category: "transactional",
    placeholders: { token: { type: "label" }, amount_paisa: { type: "paisa" }, period: { type: "code" } },
  },
  "rent.held": {
    category: "transactional",
    placeholders: { token: { type: "code" }, amount_paisa: { type: "paisa" }, period: { type: "code" } },
  },
  "rent.payout_returned": {
    category: "transactional",
    placeholders: { token: { type: "code" }, amount_paisa: { type: "paisa" } },
  },
  "tax.certificate_available": { category: "transactional", placeholders: { fiscal_year: { type: "code" } } },
  "security.passkey_added": { category: "security", placeholders: { at: { type: "utc" } } },
  "security.passkey_removed": { category: "security", placeholders: { at: { type: "utc" } } },
  "security.passkey_disabled": { category: "security", placeholders: { at: { type: "utc" } } },
  "exit.update": {
    category: "transactional",
    placeholders: {
      token: { type: "label" },
      stage: { type: "word", choices: ["vote_open", "sale_agreed", "sale_completed", "sale_cancelled", "closed"] },
    },
  },
  "exit.final_credited": { category: "transactional", placeholders: { token: { type: "label" }, amount_paisa: { type: "paisa" } } },
  "exit.payout_paid": { category: "transactional", placeholders: { token: { type: "code" }, amount_paisa: { type: "paisa" } } },
  "exit.units_redeemed": { category: "transactional", placeholders: { token: { type: "label" }, units: { type: "count" } } },
  "exit.request_recorded": { category: "transactional", placeholders: { units: { type: "count" } } },
  "marketing.offering_open": { category: "marketing", placeholders: { offering: { type: "label" } } },
  "officer.action_waiting": {
    category: "transactional",
    placeholders: {
      queue: {
        type: "word",
        choices: [
          "signing",
          "trustee_cosign",
          "offering_request",
          "payout_release",
          "kyc_review",
          "freeze_decision",
          "compliance_case",
          "distribution_approval",
          "trustee_precheck",
          "distribution_review",
          "exit_decision",
          "transfer_review",
        ],
      },
      reference: { type: "code" },
    },
  },
  "officer.alert": {
    category: "security",
    placeholders: {
      topic: { type: "word", choices: ["payouts_paused", "payouts_resumed", "passkey_clone", "sla_breach"] },
      reference: { type: "code" },
      at: { type: "utc" },
    },
  },
} as const satisfies Record<string, KindSpec>;

/** Kinds addressed to officers (PT Control); every other kind reaches investors and must not tip off (NP-4). */
export function isOfficerKind(kind: string): boolean {
  return kind.startsWith("officer.");
}

export type EventKind = keyof typeof EVENT_KINDS;

type ValueOf<S> = S extends { type: "word"; choices: readonly (infer C)[] }
  ? C
  : S extends { type: "utc" }
    ? Date | string
    : S extends { type: "paisa" | "count" }
      ? bigint
      : string;

/** The parameters of one event kind, with TypeScript types per placeholder. */
export type EventParams<K extends EventKind> = {
  -readonly [P in keyof (typeof EVENT_KINDS)[K]["placeholders"]]: ValueOf<(typeof EVENT_KINDS)[K]["placeholders"][P]>;
};

/** A typed event: the kind and its parameters. */
export type NotifyEvent = { [K in EventKind]: { kind: K; params: EventParams<K> } }[EventKind];

export function isEventKind(kind: string): kind is EventKind {
  return Object.hasOwn(EVENT_KINDS, kind);
}

export function kindSpec(kind: EventKind): KindSpec {
  // eslint-disable-next-line security/detect-object-injection -- kind is checked to be a catalogue key
  return EVENT_KINDS[kind];
}

// The same rules as notify.params_problem (SQL), checked before the database sees the values.
// eslint-disable-next-line security/detect-unsafe-regex -- anchored, bounded repetition only
const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$/;
const LONG_DIGITS = /[0-9]{7}/;

export function valueSchema(spec: PlaceholderSpec): z.ZodType<string> {
  switch (spec.type) {
    case "utc":
      return z.string().regex(UTC, "a UTC time like 2026-10-13T09:00:00Z").refine((s) => !Number.isNaN(Date.parse(s)), "a valid time");
    case "paisa":
      return z.string().regex(/^(0|[1-9][0-9]{0,17})$/, "a whole number of paisa");
    case "count":
      return z.string().regex(/^(0|[1-9][0-9]{0,17})$/, "a whole number");
    case "last4":
      return z.string().regex(/^[0-9]{4}$/, "exactly four digits");
    case "code":
      return z
        .string()
        .min(1)
        .max(40)
        .regex(/^[A-Z0-9][A-Z0-9-]*$/, "an upper-case code")
        .refine((s) => !LONG_DIGITS.test(s), "no runs of 7 or more digits (looks like a phone, CNIC or account number)");
    case "label":
      return z
        .string()
        .min(1)
        .max(48)
        .regex(/^[A-Za-z][A-Za-z0-9 .()/,-]*$/, "a short plain label")
        .refine((s) => !LONG_DIGITS.test(s), "no runs of 7 or more digits (looks like a phone, CNIC or account number)");
    case "word":
      return z.enum((spec.choices ?? []) as [string, ...string[]]);
  }
}

/** Converts typed values to the strings stored in the database. */
function toWire(spec: PlaceholderSpec, value: unknown): unknown {
  if (spec.type === "utc" && value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "invalid";
    return value.toISOString();
  }
  if ((spec.type === "paisa" || spec.type === "count") && typeof value === "bigint") return value.toString();
  return value;
}

export class EventError extends Error {
  override name = "EventError";
}

/**
 * Validates an event's parameters against the catalogue and returns them as stored strings.
 * Unknown keys are refused (a strict object), so nothing extra can slip into a message.
 */
export function wireParams(kind: string, params: Readonly<Record<string, unknown>>): Record<string, string> {
  if (!isEventKind(kind)) throw new EventError(`unknown event kind ${kind}`);
  const spec = kindSpec(kind);
  const shape: Record<string, z.ZodType<string>> = {};
  const wire: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(spec.placeholders)) {
    // eslint-disable-next-line security/detect-object-injection -- names come from the fixed catalogue
    shape[name] = valueSchema(p);
    // eslint-disable-next-line security/detect-object-injection -- names come from the fixed catalogue
    wire[name] = Object.hasOwn(params, name) ? toWire(p, params[name]) : undefined;
  }
  for (const key of Object.keys(params)) {
    if (!Object.hasOwn(spec.placeholders, key)) throw new EventError(`${kind}: parameter ${key} is not a placeholder`);
  }
  const parsed = z.strictObject(shape).safeParse(wire);
  if (!parsed.success) {
    throw new EventError(`${kind}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}
