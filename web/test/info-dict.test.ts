import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INFO_PATHS, infoChrome, infoPage, type InfoKey } from "../src/lib/i18n-info";

/** Public information pages: every page exists as a route and has the same shape in English and Urdu. */
describe("information pages", () => {
  const paths = new Map(Object.entries(INFO_PATHS) as [InfoKey, string][]);

  it("each has a route file", () => {
    for (const path of paths.values()) {
      const file = join(__dirname, "..", "src", "app", ...path.split("/").filter(Boolean), "page.tsx");
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed paths from INFO_PATHS inside the app
      expect(existsSync(file), path).toBe(true);
    }
  });

  it("English and Urdu have the same sections, items and draft flags", () => {
    const names = (lang: "en" | "ur") => new Map(Object.entries(infoChrome(lang).names));
    for (const k of paths.keys()) {
      const en = infoPage("en", k);
      const ur = infoPage("ur", k);
      expect(ur.draft, k).toBe(en.draft);
      expect(ur.sections.length, k).toBe(en.sections.length);
      en.sections.forEach((s, i) => {
        const u = ur.sections.at(i);
        expect(u?.list?.length ?? 0, `${k} ${s.h}`).toBe(s.list?.length ?? 0);
        expect(u?.p?.length ?? 0, `${k} ${s.h}`).toBe(s.p?.length ?? 0);
      });
      expect(names("ur").get(k)).not.toBe(names("en").get(k));
    }
  });

  it("legal pages carry the draft banner until counsel approves them", () => {
    for (const k of ["terms", "privacy", "risks", "fees"] as const) expect(infoPage("en", k).draft).toBe(true);
  });
});
