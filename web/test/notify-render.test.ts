import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { notifyDict } from "../src/lib/i18n-notify";
import { NOTIFY_WORDS, notifyPaisa, notifyTime, renderNotice } from "../src/lib/notify-render";

/** The in-app rendering of notifications (T-028, migration 0030 NP-8): the same formatting as the backend's e-mail. */

const spec = { offering: { type: "label" as const }, amount_paisa: { type: "paisa" as const }, expires_at: { type: "utc" as const }, units: { type: "count" as const } };

describe("notification rendering", () => {
  it("formats time in PKT, money from paisa and counts, in English and Urdu", () => {
    expect(notifyTime("2026-10-13T21:30:00Z", "en")).toBe("14 Oct 2026, 02:30 PKT");
    expect(notifyTime("2026-10-13T21:30:00Z", "ur")).toBe("14-10-2026 02:30 PKT");
    expect(notifyTime("yesterday", "en")).toBe("—");
    expect(notifyPaisa("123456789", "en")).toBe("PKR 1,234,567.89");
    expect(notifyPaisa("5", "ur")).toBe("0.05 روپے");
    expect(notifyPaisa("-1", "en")).toBe("—");
    const r = renderNotice(
      {
        kind: "offering.reserved",
        subject: "Units in {{offering}}",
        body: "Pay {{amount_paisa}} before {{expires_at}} for {{units}} units.\n\nSecond paragraph.",
        params: { offering: "Gulberg Heights", amount_paisa: "1000000", expires_at: "2026-10-13T09:00:00Z", units: "1200" },
        placeholders: spec,
      },
      "en",
    );
    expect(r).toEqual({ title: "Units in Gulberg Heights", paragraphs: ["Pay PKR 10,000.00 before 13 Oct 2026, 14:00 PKT for 1,200 units.", "Second paragraph."] });
  });

  it("isolates left-to-right values in Urdu, translates words, shows unknown values as a dash and never markup", () => {
    const r = renderNotice(
      { kind: "security.kyc_status_changed", subject: "حیثیت {{status}}", body: "{{status}} {{offering}} {{missing}}", params: { status: "action_required", offering: "<b>X</b>" }, placeholders: { status: { type: "word" }, offering: { type: "label" } } },
      "ur",
    );
    expect(r.title).toBe("حیثیت کارروائی درکار");
    expect(r.paragraphs[0]).toBe("کارروائی درکار \u2066<b>X</b>\u2069 —");
    expect(renderNotice({ kind: "x.y", subject: null, body: null, params: {}, placeholders: {} }, "en")).toEqual({ title: "x.y", paragraphs: [] });
  });

  it("English and Urdu texts of the page have the same keys", () => {
    expect(Object.keys(notifyDict("ur")).sort()).toEqual(Object.keys(notifyDict("en")).sort());
  });

  const backendRender = join(import.meta.dirname, "..", "..", "backend", "packages", "notify", "src", "render.ts");
  it.skipIf(!existsSync(backendRender))("every word an investor notice can carry reads the same as in the backend's messages", async () => {
    const be = (await import(/* @vite-ignore */ pathToFileURL(backendRender).href)) as { WORDS: Record<string, Record<string, string>> };
    const ev = (await import(/* @vite-ignore */ pathToFileURL(join(backendRender, "..", "events.ts")).href)) as {
      EVENT_KINDS: Record<string, { placeholders: Record<string, { choices?: readonly string[] }> }>;
    };
    const investorWords = new Set(
      Object.entries(ev.EVENT_KINDS)
        .filter(([k]) => !k.startsWith("officer."))
        .flatMap(([, s]) => Object.values(s.placeholders).flatMap((p) => p.choices ?? [])),
    );
    expect(investorWords.size).toBeGreaterThan(10);
    for (const w of investorWords) {
      expect(Object.hasOwn(NOTIFY_WORDS, w), w).toBe(true);
      // eslint-disable-next-line security/detect-object-injection -- checked above
      expect(NOTIFY_WORDS[w], w).toEqual(be.WORDS[w]);
    }
  });
});
