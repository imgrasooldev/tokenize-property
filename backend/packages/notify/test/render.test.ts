import { randomBytes } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ContactSecrets, normalizeEmail, normalizePhone } from "../src/crypto.ts";
import { wireParams } from "../src/events.ts";
import { MockProvider } from "../src/providers.ts";
import { escapeHtml, formatPaisa, formatTime, render, RenderError, smsSegments } from "../src/render.ts";
import { redact } from "../src/worker.ts";

/** Pure tests: catalogue validation, rendering (escaping, Urdu, SMS length), contact sealing. */

describe("event parameters (N-2)", () => {
  it("accepts typed values and converts them to stored strings", () => {
    expect(wireParams("security.payout_account_changed", { last4: "1234", previous_last4: "9876", active_from: new Date("2026-10-16T09:00:00Z") })).toEqual({
      last4: "1234",
      previous_last4: "9876",
      active_from: "2026-10-16T09:00:00.000Z",
    });
    expect(wireParams("rent.paid", { token: "PTK-GULBERG", amount_paisa: 123_456_789n, period: "2026-10" })).toMatchObject({ amount_paisa: "123456789" });
  });

  it("refuses anything that could carry personal data", () => {
    // Unknown keys (a name), phone-like and CNIC-like digit runs, e-mail addresses, free text.
    expect(() => wireParams("rent.paid", { token: "PTK", amount_paisa: 1n, period: "2026-10", name: "Ali Khan" })).toThrow(/not a placeholder/);
    expect(() => wireParams("security.large_transaction_pending", { amount_paisa: 1n, reference: "03001234567" })).toThrow(/digits/);
    expect(() => wireParams("security.new_device_sign_in", { device: "ali@example.pk", at: "2026-10-13T09:00:00Z" })).toThrow();
    expect(() => wireParams("security.new_device_sign_in", { device: "Phone 3520212345671", at: "2026-10-13T09:00:00Z" })).toThrow(/digits/);
    expect(() => wireParams("security.kyc_status_changed", { status: "sanctions_hit" })).toThrow();
    expect(() => wireParams("security.payout_account_added", { last4: "12345", active_from: "2026-10-13T09:00:00Z" })).toThrow();
    expect(() => wireParams("security.account_frozen", { at: "13 Oct 2026" })).toThrow(/UTC/);
    expect(() => wireParams("security.account_frozen", {})).toThrow();
    expect(() => wireParams("no.such_kind", {})).toThrow(/unknown event kind/);
  });
});

describe("rendering", () => {
  it("formats money from paisa without floating point, and time in PKT", () => {
    expect(formatPaisa("123456789", "en")).toBe("PKR 1,234,567.89");
    expect(formatPaisa("5", "en")).toBe("PKR 0.05");
    expect(formatPaisa("999999999999999999", "en")).toBe("PKR 9,999,999,999,999,999.99");
    expect(formatPaisa("100", "ur")).toBe("1.00 روپے");
    expect(formatTime("2026-10-13T21:30:00Z", "en")).toBe("14 Oct 2026, 02:30 PKT");
    expect(formatTime("2026-10-13T21:30:00Z", "ur")).toBe("14-10-2026 02:30 PKT");
  });

  it("escapes values in e-mail HTML and keeps CR/LF out of the subject", () => {
    const html = render({
      kind: "security.new_device_sign_in",
      channel: "email",
      locale: "en",
      subject: "Sign-in {{device}}",
      body: "Device: {{device}}\n\nAt {{at}}",
      params: { device: "Chrome (Win) a/b", at: "2026-10-13T09:00:00Z" },
    });
    expect(html.subject).toBe("Sign-in Chrome (Win) a/b");
    expect(html.html).toContain("<p>Device: Chrome (Win) a/b</p>");
    expect(escapeHtml(`<script>"x"&'y'</script>`)).toBe("&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;");
    // A template body with markup is shown as text, never as markup.
    const markup = render({ kind: "security.account_frozen", channel: "email", locale: "en", subject: "S", body: "<b>{{at}}</b>", params: { at: "2026-10-13T09:00:00Z" } });
    expect(markup.html).toContain("&lt;b&gt;13 Oct 2026, 14:00 PKT&lt;/b&gt;");
  });

  it("marks Urdu e-mail right-to-left and isolates left-to-right values", () => {
    const r = render({
      kind: "rent.paid",
      channel: "email",
      locale: "ur",
      subject: "کرایہ {{token}}",
      body: "{{token}} کا کرایہ {{amount_paisa}}",
      params: { token: "PTK-GULBERG", amount_paisa: "250000", period: "2026-10" },
    });
    expect(r.html).toContain('<html lang="ur" dir="rtl">');
    expect(r.text).toContain("\u2066PTK-GULBERG\u2069");
    expect(r.text).toContain("2,500.00 روپے"); // contains Urdu letters: no isolate needed
  });

  it("refuses unknown placeholders, bad parameters and over-long SMS", () => {
    expect(() => render({ kind: "security.account_frozen", channel: "sms", locale: "en", subject: null, body: "{{name}}", params: { at: "2026-10-13T09:00:00Z" } })).toThrow(RenderError);
    expect(() => render({ kind: "security.account_frozen", channel: "sms", locale: "en", subject: null, body: "{{at}}", params: { at: "yesterday" } })).toThrow(RenderError);
    expect(() => render({ kind: "security.account_frozen", channel: "sms", locale: "ur", subject: null, body: "ا".repeat(202), params: { at: "2026-10-13T09:00:00Z" } })).toThrow(/segments/);
    expect(() => render({ kind: "security.account_frozen", channel: "email", locale: "en", subject: null, body: "x", params: { at: "2026-10-13T09:00:00Z" } })).toThrow(/subject/);
  });

  it("counts SMS segments for GSM-7 and UCS-2 (Urdu)", () => {
    expect(smsSegments("a".repeat(160))).toEqual({ encoding: "gsm7", units: 160, segments: 1 });
    expect(smsSegments("a".repeat(161)).segments).toBe(2);
    expect(smsSegments("€".repeat(80))).toEqual({ encoding: "gsm7", units: 160, segments: 1 });
    expect(smsSegments("ا".repeat(70))).toEqual({ encoding: "ucs2", units: 70, segments: 1 });
    expect(smsSegments("ا".repeat(71)).segments).toBe(2);
    expect(smsSegments("ا".repeat(201)).segments).toBe(3);
    expect(smsSegments("ا".repeat(202)).segments).toBe(4);
  });

  it("has no control characters or line breaks in a rendered SMS (property)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (body) => {
        const safe = body.replace(/[{}]/g, "");
        const r = render({ kind: "security.account_unfrozen", channel: "sms", locale: "en", subject: null, body: `${safe} {{at}}`.slice(0, 160), params: { at: "2026-10-13T09:00:00Z" } });
        // eslint-disable-next-line no-control-regex -- checking for control characters
        return !/[\u0000-\u001f\u007f]/.test(r.text);
      }),
      { numRuns: 200, seed: 0x5eed },
    );
  });
});

describe("contact sealing (N-1)", () => {
  const secrets = ContactSecrets.of(randomBytes(32), randomBytes(32));
  const recipient = "6f1c7c4e-2c1b-4a63-9a0e-3b7f4b8f2a10";

  it("normalises phone numbers and e-mail addresses", () => {
    expect(normalizePhone("0300-1234567")).toBe("+923001234567");
    expect(normalizePhone("+92 300 1234567")).toBe("+923001234567");
    expect(normalizePhone("00923001234567")).toBe("+923001234567");
    expect(normalizePhone("+447700900123")).toBe("+447700900123");
    expect(() => normalizePhone("0421234567")).toThrow();
    expect(() => normalizePhone("+924212345678")).toThrow(/mobile/);
    expect(normalizeEmail("  Ali.Khan@Example.PK ")).toBe("ali.khan@example.pk");
    expect(() => normalizeEmail("not-an-address")).toThrow();
    expect(() => normalizeEmail("a@b.pk\r\nBcc: x@y.pk")).toThrow();
  });

  it("hashes with a key (same number, same hash, however typed) and seals bound to recipient and channel", () => {
    const a = secrets.protect(recipient, "sms", "0300 1234567");
    const b = secrets.protect(recipient, "sms", "+923001234567");
    expect(a.lookupHash.equals(b.lookupHash)).toBe(true);
    expect(a.sealed.equals(b.sealed)).toBe(false); // random IV
    expect(a.sealed.toString("latin1")).not.toContain("923001234567");
    expect(secrets.open({ recipientId: recipient, channel: "sms", lookupHash: a.lookupHash, sealed: a.sealed, keyVersion: 1 })).toBe("+923001234567");
    // Moved to another recipient or channel, or opened with another key: refused.
    expect(() => secrets.open({ recipientId: "00000000-0000-4000-8000-000000000000", channel: "sms", lookupHash: a.lookupHash, sealed: a.sealed, keyVersion: 1 })).toThrow();
    expect(() => secrets.open({ recipientId: recipient, channel: "email", lookupHash: a.lookupHash, sealed: a.sealed, keyVersion: 1 })).toThrow();
    const other = ContactSecrets.of(randomBytes(32), randomBytes(32));
    expect(() => other.open({ recipientId: recipient, channel: "sms", lookupHash: a.lookupHash, sealed: a.sealed, keyVersion: 1 })).toThrow();
    // The same number under another lookup key gives another hash (no cross-system linking).
    expect(other.lookupHash("sms", "+923001234567").equals(a.lookupHash)).toBe(false);
    expect(() => ContactSecrets.of(Buffer.alloc(32, 1), Buffer.alloc(32, 1))).toThrow(/differ/);
  });

  it("redacts contact details from provider error texts", () => {
    expect(redact("invalid recipient +92 300 1234567 for ali.khan@example.pk")).toBe("invalid recipient [number] for [email]");
    expect(redact("rate limited, retry in 30 s")).toBe("rate limited, retry in 30 s");
  });
});

describe("mock provider", () => {
  it("records what would be sent and deduplicates by idempotency key when asked to", async () => {
    const p = new MockProvider("sms");
    const msg = { idempotencyKey: "k1", channel: "sms" as const, to: "+923001234567", locale: "en" as const, text: "hi" };
    const a = await p.send(msg, new AbortController().signal);
    const b = await p.send(msg, new AbortController().signal);
    expect(a.messageId).toBe(b.messageId);
    expect(p.acceptances("k1")).toBe(1);
    expect(await p.lookup("k1")).toEqual({ state: "accepted", messageId: a.messageId });
    expect(await p.lookup("k2")).toEqual({ state: "not_found" });
    const worst = new MockProvider("sms", { dedupe: false });
    await worst.send(msg, new AbortController().signal);
    await worst.send(msg, new AbortController().signal);
    expect(worst.acceptances("k1")).toBe(2);
  });
});
