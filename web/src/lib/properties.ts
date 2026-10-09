/**
 * Property catalogue for the prototype. All entries are SAMPLE properties for demonstration; the
 * figures are illustrative, not offers. Live token data (supply, cap, paused) for properties with a
 * deployed token is read from the local chain at request time.
 */

export type PropertyStatus = "live" | "coming_soon";
export type PropertyType = "office" | "retail";

export interface Property {
  symbol: string;
  name: { en: string; ur: string };
  city: { en: string; ur: string };
  type: PropertyType;
  status: PropertyStatus;
  /** Total units on the trustee register. */
  units: number;
  /** Price per token (net asset value) in PKR. */
  navPkr: number;
  /** Net annual rent yield, percent. */
  yieldPct: number;
  occupancyPct: number;
  areaSqft: number;
  tenant: { en: string; ur: string };
  /** Visual style of the generated illustration. */
  art: "tower" | "mall" | "office";
}

export const PROPERTIES: Property[] = [
  {
    symbol: "GPF3",
    name: { en: "Gulberg Plaza, Floor 3", ur: "گلبرگ پلازہ، تیسری منزل" },
    city: { en: "Lahore", ur: "لاہور" },
    type: "office",
    status: "live",
    units: 1_000_000,
    navPkr: 500,
    yieldPct: 9.2,
    occupancyPct: 100,
    areaSqft: 18_500,
    tenant: { en: "Bank regional office (sample)", ur: "بینک کا علاقائی دفتر (نمونہ)" },
    art: "tower",
  },
  {
    symbol: "DHA6",
    name: { en: "DHA Phase 6 Retail Unit", ur: "ڈی ایچ اے فیز 6 ریٹیل یونٹ" },
    city: { en: "Karachi", ur: "کراچی" },
    type: "retail",
    status: "coming_soon",
    units: 560_000,
    navPkr: 500,
    yieldPct: 8.4,
    occupancyPct: 100,
    areaSqft: 9_200,
    tenant: { en: "Pharmacy chain (sample)", ur: "فارمیسی چین (نمونہ)" },
    art: "mall",
  },
  {
    symbol: "BAO2",
    name: { en: "Blue Area Office, Floor 2", ur: "بلیو ایریا آفس، دوسری منزل" },
    city: { en: "Islamabad", ur: "اسلام آباد" },
    type: "office",
    status: "coming_soon",
    units: 700_000,
    navPkr: 500,
    yieldPct: 8.9,
    occupancyPct: 92,
    areaSqft: 14_000,
    tenant: { en: "Telecom company (sample)", ur: "ٹیلی کام کمپنی (نمونہ)" },
    art: "office",
  },
];

export function findProperty(symbol: string): Property | undefined {
  return PROPERTIES.find((p) => p.symbol === symbol);
}

/** Deterministic sample history: monthly NAV and rent per token for the last 24 months. */
export function sampleHistory(p: Property): { month: string; nav: number; rent: number }[] {
  const out: { month: string; nav: number; rent: number }[] = [];
  const now = new Date();
  // Symbols are ASCII (A-Z, 0-9), so char codes are safe here.
  let seed = 0;
  for (let i = 0; i < p.symbol.length; i++) seed += p.symbol.charCodeAt(i);
  const rand = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  for (let i = 23; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const growth = 1 - (i / 24) * 0.11; // ~11% appreciation over two years
    const nav = Math.round(p.navPkr * growth * (0.99 + rand() * 0.02) * 100) / 100;
    const rent = Math.round(((p.navPkr * p.yieldPct) / 100 / 12) * (0.97 + rand() * 0.06) * 100) / 100;
    out.push({ month: d.toISOString().slice(0, 10), nav, rent });
  }
  return out;
}
