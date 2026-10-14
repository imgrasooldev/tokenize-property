import { hasWord, normalizeText } from "./normalize";
import type { Intent, Scope } from "./types";

/**
 * Intent detection (pure, ADR 0015): keyword tables in English, Roman Urdu and Urdu script.
 * Guardrails come first: a question asking whether to buy or sell, for a prediction or for personal
 * financial advice is refused (with facts) whatever else it mentions. Otherwise the intent whose
 * matched keywords are longest wins; ties follow the order of TOPICS.
 */

type Table = readonly (readonly [Intent, readonly string[]])[];

const GUARDS: Table = [
  [
    "personal",
    [
      "how much should i invest",
      "how much should i put",
      "how much money should i",
      "my savings",
      "my salary",
      "my pension",
      "retirement",
      "take a loan",
      "borrow",
      "tax advice",
      "financial advice",
      "kitna invest karun",
      "kitna invest karoon",
      "kitne paise lagaun",
      "kitne paise lagaon",
      "kitna paisa lagaun",
      "meri bachat",
      "meri tankhwah",
      "meri tankhwa",
      "qarz le",
      "کتنا لگاؤں",
      "کتنے پیسے لگاؤں",
      "کتنی سرمایہ کاری کروں",
      "میری بچت",
      "میری تنخواہ",
      "قرض لے",
      "مالی مشورہ",
    ],
  ],
  [
    "advice",
    [
      "should i buy",
      "should i sell",
      "should i invest",
      "should i hold",
      "shall i buy",
      "do you recommend",
      "would you recommend",
      "recommend buying",
      "good investment",
      "good buy",
      "worth buying",
      "worth investing",
      "worth it",
      "buy or sell",
      "best property to buy",
      "which property should",
      "safe investment",
      "kya kharidun",
      "kya khareedun",
      "kharidun",
      "khareedun",
      "kharid lun",
      "khareed lun",
      "kharidna chahiye",
      "khareedna chahiye",
      "bechna chahiye",
      "bech dun",
      "invest karun",
      "invest karoon",
      "invest karna chahiye",
      "acha investment",
      "achi investment",
      "achha investment",
      "acchi investment",
      "faida mand hai",
      "خریدوں",
      "خرید لوں",
      "خریدنا چاہیے",
      "بیچنا چاہیے",
      "بیچ دوں",
      "سرمایہ کاری کروں",
      "سرمایہ کاری کرنی چاہیے",
      "اچھی سرمایہ کاری",
      "کیا مشورہ",
      "مشورہ دیں",
    ],
  ],
  [
    "prediction",
    [
      "will the price",
      "will price",
      "will it go up",
      "will it rise",
      "go up",
      "go down",
      "next year",
      "next month",
      "in future",
      "future price",
      "future value",
      "future return",
      "forecast",
      "predict",
      "prediction",
      "expected return",
      "guaranteed return",
      "will i earn",
      "will i make",
      "barhegi",
      "badhegi",
      "barhay gi",
      "barhe gi",
      "barhay ga",
      "girega",
      "giregi",
      "agle saal",
      "aglay saal",
      "mustaqbil",
      "بڑھے گی",
      "بڑھے گا",
      "گرے گی",
      "گرے گا",
      "اگلے سال",
      "مستقبل",
      "پیشگوئی",
    ],
  ],
];

const TOPICS: Table = [
  ["portfolio", ["my portfolio", "my holdings", "my holding", "my tokens", "my rent", "my investment", "my subscriptions", "i received", "i got", "have i", "did i", "do i own", "do i have", "tokens do i", "portfolio", "mera portfolio", "mere portfolio", "mere token", "meri holding", "mujhe kitna", "mujhe mila", "میرا پورٹ فولیو", "میرے پورٹ فولیو", "پورٹ فولیو", "میرے ٹوکن", "میری ہولڈنگ", "مجھے", "ملا"]],
  ["score", ["score", "rating", "rated", "اسکور", "سکور", "ریٹنگ"]],
  ["fees", ["fee", "fees", "charge", "charges", "commission", "fees kitni", "kitni fees", "فیس", "کمیشن", "چارجز"]],
  ["yield", ["yield", "return", "returns", "roi", "income", "munafa", "munafa kitna", "kiraye ka munafa", "منافع", "آمدنی", "کرائے کا منافع"]],
  ["occupancy", ["occupancy", "occupied", "tenant", "tenants", "tenanted", "lease", "leases", "vacant", "kirayedar", "kirayadar", "kiraedar", "کرایہ دار", "کرائے دار", "لیز", "خالی"]],
  ["rent", ["rent", "rental", "distribution", "distributions", "payout", "payouts", "kiraya", "kiraaya", "kiraye", "کرایہ", "کرائے", "تقسیم"]],
  ["documents", ["document", "documents", "title deed", "deed", "valuation report", "valuation", "insurance", "hash", "sha", "dastavez", "dastaweez", "kaghzat", "kagzat", "دستاویز", "دستاویزات", "کاغذات", "رجسٹری"]],
  ["supply", ["supply", "holders", "holder", "how many tokens", "tokens issued", "issued", "minted", "kitne token", "سپلائی", "ہولڈر", "ہولڈرز", "کتنے ٹوکن"]],
  ["price", ["price", "prices", "nav", "cost", "trade", "traded", "market price", "token price", "qeemat", "keemat", "qimat", "kimat", "rate", "قیمت", "ریٹ", "دام"]],
  ["risk", ["risk", "risks", "risky", "safe", "danger", "concentration", "reconciliation", "paused", "khatra", "khatre", "khatrat", "خطرہ", "خطرے", "خطرات", "رسک"]],
  ["offering", ["offering", "offerings", "subscription", "subscribe", "ipo", "terms", "minimum units", "closes", "opens", "allotment", "پیشکش", "آفرنگ", "سبسکرپشن"]],
  ["how", ["how does it work", "how it works", "how do i invest", "how to invest", "how does this work", "tokenization", "tokenisation", "what is this", "kaise kaam", "kese kaam", "kaise invest", "kese invest", "کیسے کام", "طریقہ", "طریقۂ کار", "کیسے سرمایہ"]],
];

const SUMMARY = ["summary", "summarise", "summarize", "overview", "khulasa", "خلاصہ"];

function normalizeTable(t: Table): [Intent, string[]][] {
  return t.map(([i, kws]) => [i, kws.map((k) => normalizeText(k)).filter((k) => k.length > 0)]);
}

const GUARD_N = normalizeTable(GUARDS);
const TOPIC_N = normalizeTable(TOPICS);
const SUMMARY_N = SUMMARY.map((k) => normalizeText(k));

function best(table: [Intent, string[]][], text: string): Intent | null {
  let win: Intent | null = null;
  let top = 0;
  for (const [intent, kws] of table) {
    const score = kws.reduce((a, k) => (hasWord(text, k) ? a + k.length : a), 0);
    if (score > top) {
      top = score;
      win = intent;
    }
  }
  return win;
}

/** The question's intent. `scope` "portfolio" turns "summary"-style questions into "portfolio". */
export function detectIntent(question: string, scope: Scope = "site"): Intent {
  const text = normalizeText(question.slice(0, 300));
  if (text.length === 0) return "unknown";
  const guard = best(GUARD_N, text);
  if (guard) return guard;
  const topic = best(TOPIC_N, text);
  if (topic) return topic;
  if (scope === "portfolio" && SUMMARY_N.some((k) => hasWord(text, k))) return "portfolio";
  return "unknown";
}

export const GUARDRAIL_INTENTS: readonly Intent[] = ["advice", "prediction", "personal"];

export function isGuardrail(intent: Intent): intent is "advice" | "prediction" | "personal" {
  return GUARDRAIL_INTENTS.includes(intent);
}
