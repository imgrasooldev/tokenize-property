import { describe, expect, it } from "vitest";
import { normalizeText } from "../src/lib/server/analyst/normalize";
import { entriesMentioned, searchCatalog } from "../src/lib/server/search";
import type { CatalogEntry } from "../src/lib/server/catalog";
import { fixtureCatalog, OFFERING_ID, tokenEntry } from "./analyst-fixtures";

const entries = fixtureCatalog().entries;

function ok(q: string, lang: "en" | "ur" = "en", list: readonly CatalogEntry[] = entries) {
  const r = searchCatalog(q, lang, list);
  if (!r.ok) throw new Error(`expected results for ${q}`);
  return r.results;
}

describe("normalizeText", () => {
  it("folds case, Latin diacritics, Arabic letter forms, Urdu digits and harakat", () => {
    expect(normalizeText("Gulbérg  PLAZA!")).toBe("gulberg plaza");
    expect(normalizeText("كراچي")).toBe(normalizeText("کراچی"));
    expect(normalizeText("۱۲۳")).toBe("123");
    expect(normalizeText("مَنزِل")).toBe(normalizeText("منزل"));
  });
});

describe("searchCatalog", () => {
  it("ranks an exact symbol above a name match above a district match", () => {
    const other: CatalogEntry = { ...tokenEntry(), key: "LHR1", symbol: "LHR1", href: "/properties/LHR1", name: { en: "Gulberg Heights", ur: "گلبرگ ہائٹس" }, district: "Gulberg", city: { en: "Lahore", ur: "لاہور" } };
    const third: CatalogEntry = { ...tokenEntry(), key: "GBG2", symbol: "GBG2", href: "/properties/GBG2", name: { en: "Model Town Tower", ur: "ماڈل ٹاؤن ٹاور" }, district: "Gulberg" };
    const list = [third, other, ...entries];
    const bySymbol = ok("GPF3", "en", list);
    expect(bySymbol[0]?.key).toBe("GPF3");
    expect(bySymbol[0]?.matched).toBe("symbol");
    const byName = ok("gulberg", "en", list);
    expect(byName.map((r) => r.matched).slice(0, 3)).toEqual(["name", "name", "district"]);
    expect(byName[2]?.key).toBe("GBG2");
    expect(byName.findIndex((r) => r.key === "GBG2")).toBeGreaterThan(byName.findIndex((r) => r.key === "LHR1"));
  });

  it("is case- and diacritic-insensitive", () => {
    expect(ok("gpf3")[0]?.key).toBe("GPF3");
    expect(ok("GULBÉRG")[0]?.key).toBe("GPF3");
  });

  it("matches Urdu queries against Urdu names, cities and provinces", () => {
    expect(ok("گلبرگ", "ur")[0]?.key).toBe("GPF3");
    expect(ok("لاہور", "ur")[0]?.key).toBe("GPF3");
    expect(ok("سندھ", "ur")[0]?.key).toBe(OFFERING_ID);
    expect(ok("کلفٹن", "ur")[0]?.title).toBe("کلفٹن ریزیڈنسی");
  });

  it("finds places, property types, status words and site pages", () => {
    expect(ok("karachi")[0]?.key).toBe(OFFERING_ID);
    expect(ok("Sindh")[0]?.matched).toBe("province");
    expect(ok("residential")[0]?.key).toBe(OFFERING_ID);
    expect(ok("verify").some((r) => r.kind === "page" && r.href === "/verify")).toBe(true);
    expect(ok("market").some((r) => r.href === "/market")).toBe(true);
    expect(ok("how it works").some((r) => r.href === "/#how")).toBe(true);
  });

  it("refuses empty and too long queries and returns nothing for no match", () => {
    expect(searchCatalog("   ", "en", entries)).toEqual({ ok: false, reason: "empty" });
    expect(searchCatalog("?!", "en", entries)).toEqual({ ok: false, reason: "empty" });
    expect(searchCatalog("x".repeat(81), "en", entries)).toEqual({ ok: false, reason: "tooLong" });
    expect(searchCatalog("x".repeat(80), "en", entries).ok).toBe(true);
    expect(ok("zzqqxx")).toEqual([]);
  });
});

describe("entriesMentioned", () => {
  it("finds a property a question names by symbol or distinctive name", () => {
    expect(entriesMentioned("What rent has GPF3 paid?", entries).map((e) => e.key)).toEqual(["GPF3"]);
    expect(entriesMentioned("rent of gulberg plaza", entries).map((e) => e.key)).toEqual(["GPF3"]);
    expect(entriesMentioned("What are the risks?", entries)).toEqual([]);
  });
});
