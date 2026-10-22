import { PROPERTIES } from "../../properties";
import { catalog } from "../catalog";
import type { InvestorRow } from "../db";
import { subscriptionsOf } from "../invest";
import { mySubscriptions } from "../offerings";
import { holdingOf, indexStatus, liveToken } from "../readmodel";
import { distributionsFor } from "../rent";
import { entriesMentioned } from "../search";
import { buildRetrieved, portfolioFacts, type PortfolioData } from "./facts";
import type { Intent, Question, Retrieved } from "./types";

/**
 * Loads the facts for a question from the website's existing read paths only: the catalogue
 * (chain read model, offering and property records, reconciliation), and for portfolio questions
 * the signed-in investor's OWN holdings, rent statements and subscriptions. Never another
 * investor's data, never personal details (name, CNIC, phone, wallet) in a fact.
 */

const ENDED_OFFERING_SUBS = new Set(["redeemed", "refunded", "rejected", "expired", "cancelled"]);

export async function loadPortfolio(investor: InvestorRow): Promise<PortfolioData> {
  const at = new Date().toISOString();
  const [status, holdings, dists, subs, offeringSubs] = await Promise.all([
    indexStatus(),
    Promise.all(
      PROPERTIES.map(async (p) => {
        const live = await liveToken(p.symbol);
        const tokens = live ? await holdingOf(investor.wallet_address) : null;
        return live && tokens !== null ? { symbol: p.symbol, tokens, asOfBlock: live.asOfBlock.toString(), issuePricePaisa: BigInt(p.navPkr) * 100n } : null;
      }),
    ),
    distributionsFor(investor.wallet_address).catch(() => null),
    subscriptionsOf(investor.id).catch(() => null),
    mySubscriptions(investor).catch(() => null),
  ]);
  let rent: PortfolioData["rent"] = null;
  if (dists) {
    let received = 0n;
    let count = 0;
    let latest: bigint | null = null;
    for (const d of dists) {
      if (latest === null || d.recordBlock > latest) latest = d.recordBlock;
      if (d.status === "rejected" || !d.mine) continue;
      received += d.mine.amountPaisa;
      count++;
    }
    rent = { receivedPaisa: received, count, latestBlock: latest === null ? null : latest.toString() };
  }
  return {
    at,
    block: status ? status.block.toString() : null,
    holdings: holdings.filter((h) => h !== null),
    rent,
    subs: subs
      ? {
          completed: subs.filter((s) => s.status === "done").length,
          completedPaisa: subs.filter((s) => s.status === "done").reduce((a, s) => a + BigInt(s.amount_paisa), 0n),
          open: subs.filter((s) => s.status === "paid" || s.status === "minting" || s.status === "review").length,
        }
      : null,
    offeringSubs: offeringSubs
      ? (() => {
          const active = offeringSubs.filter((s) => !ENDED_OFFERING_SUBS.has(s.state));
          return { active: active.length, amountPaisa: active.reduce((a, s) => a + s.amountPaisa, 0n) };
        })()
      : null,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SYMBOL = /^[A-Z][A-Z0-9]{2,11}$/;

/** Facts for a question; "signin" when a portfolio question has no signed-in investor. */
export async function retrieveFacts(q: Question, intent: Intent, investor: InvestorRow | null): Promise<Retrieved | "signin"> {
  if (intent === "portfolio") {
    if (!investor) return "signin";
    return portfolioFacts(await loadPortfolio(investor), q.lang);
  }
  const cat = await catalog();
  if (intent === "how" || intent === "unknown") return buildRetrieved(cat, [], intent, q.lang);
  const key = q.propertyKey;
  const byKey = key && (SYMBOL.test(key) || UUID.test(key)) ? cat.entries.filter((e) => e.key === key) : [];
  const mentioned = byKey.length > 0 ? byKey : entriesMentioned(q.text, cat.entries);
  const targets = mentioned.length > 0 ? mentioned : cat.entries;
  return buildRetrieved(cat, targets, intent, q.lang);
}
