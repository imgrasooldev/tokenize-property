import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { dictFor } from "../src/lib/i18n";
import { supportReference } from "../src/lib/support";

/**
 * T-049 follow-up: the support reference on /account is exactly what PT Control's /support lookup
 * accepts (migration 0031: left(replace(subject_id::text, '-', ''), 8), 0-9 and a-f), in both languages.
 */
describe("support reference", () => {
  it("is the first 8 hex characters of the subject id, as admin.support_lookup matches it", () => {
    for (let i = 0; i < 50; i++) {
      const id = randomUUID();
      expect(supportReference(id)).toBe(id.replace(/-/g, "").slice(0, 8));
      expect(supportReference(id.toUpperCase())).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it("is labelled in English and Urdu", () => {
    for (const lang of ["en", "ur"] as const) {
      expect(dictFor(lang).supportRef.length).toBeGreaterThan(3);
      expect(dictFor(lang).supportRefNote).toMatch(/\S/);
    }
  });
});
