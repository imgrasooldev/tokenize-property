/**
 * Listing records of the property tokens deployed on the chain the website follows. Only what the
 * deployment itself fixes is kept here: the token's name and symbol (DeployLib parameters, also on
 * chain), where the property is (for the list and the map) and the issue price the investor flow
 * uses. Everything else on the pages comes from records: the chain read model (supply, cap, pause,
 * holders, rent distributions, documents), the market and the offering/property records (migration
 * 0022). Properties that exist only as an offering come from the database, not from this file.
 *
 * The earlier sample catalogue entries (DHA6, BAO2) were removed in T-045: they had no records
 * behind them (owner rule: show real data only).
 */

export type PropertyStatus = "live";
export type PropertyUse = "commercial" | "residential" | "mixed";

export interface Property {
  symbol: string;
  name: { en: string; ur: string };
  city: { en: string; ur: string };
  province: "punjab" | "sindh" | "kp" | "balochistan" | "ict" | "gb" | "ajk";
  district: string;
  use: PropertyUse;
  status: PropertyStatus;
  /** Issue price per token in whole rupees: the price the subscription flow charges (quotePaisa). */
  navPkr: number;
  /** Visual style of the generated illustration (decorative only). */
  art: "tower" | "mall" | "office";
}

export const PROPERTIES: Property[] = [
  {
    symbol: "GPF3",
    name: { en: "Gulberg Plaza, Floor 3", ur: "گلبرگ پلازہ، تیسری منزل" },
    city: { en: "Lahore", ur: "لاہور" },
    province: "punjab",
    district: "Lahore",
    use: "commercial",
    status: "live",
    navPkr: 500,
    art: "tower",
  },
];

export function findProperty(symbol: string): Property | undefined {
  return PROPERTIES.find((p) => p.symbol === symbol);
}
