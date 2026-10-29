import { describe, expect, it } from "vitest";
import { CATEGORIES, cl, complaintsDict } from "../src/lib/i18n-complaints";

/** Complaints (migration 0040): every category, status and history step the database uses has a label in English and Urdu. */
describe("complaint labels", () => {
  it("cover the database's categories, statuses and events in both languages", () => {
    const statuses = ["open", "acknowledged", "resolved", "closed", "under_review"];
    const events = ["filed", "acknowledged", "replied", "resolved", "closed", "reopened", "under_review"];
    expect([...CATEGORIES]).toEqual(["payment", "payout", "tax", "account", "offering", "transfer", "website", "other"]);
    for (const lang of ["en", "ur"] as const) {
      const d = complaintsDict(lang);
      const has = (k: string) => Object.hasOwn(d, k);
      for (const c of CATEGORIES) expect(has(`cat_${c}`)).toBe(true);
      for (const s of statuses) expect(has(`st_${s}`)).toBe(true);
      for (const e of events) expect(has(`ev_${e}`)).toBe(true);
    }
    // "referred" never has a label: the website only ever shows "under review" (no tipping-off).
    expect(Object.hasOwn(complaintsDict("en"), "st_referred")).toBe(false);
    expect(cl(complaintsDict("ur"), "st_", "under_review")).not.toBe("under_review");
  });
});
