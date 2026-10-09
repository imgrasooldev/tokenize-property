export type Lang = "en" | "ur";

const en = {
  brand: "Property Token",
  navProperties: "Properties",
  navPortfolio: "Portfolio",
  navMarket: "Market",
  demoBanner: "Prototype on a local test network. Sample properties and test money only. Not an offer.",
  heroTitle: "Own a share of prime property, from Rs 5,000",
  heroBody:
    "Each property is held by an independent trustee. You hold tokens that mirror the trustee's register and receive your share of the rent in PKR.",
  heroSafety: "Trustee-held · KYC-verified investors only · Rent paid to your bank",
  liveOnChain: "Live on chain",
  comingSoon: "Coming soon",
  sample: "Sample property",
  pricePerToken: "Price per token",
  yield: "Rent yield",
  occupancy: "Occupancy",
  sold: "sold",
  viewProperty: "View property",
  tokensIssued: "Tokens issued",
  register: "Trustee register",
  trading: "Trading",
  tradingLive: "Live",
  tradingPaused: "Paused",
  area: "Area",
  tenant: "Tenant",
  city: "City",
  navChart: "Value per token (PKR)",
  rentChart: "Monthly rent per token (PKR)",
  sampleHistory: "Sample history for illustration",
  minInvestment: "Minimum investment",
  invest: "Invest",
  investSoon: "Investing opens in the next prototype step",
  tokenContract: "Token contract",
  verifyOnChain: "Every figure marked live is read from the blockchain at the moment you open this page.",
  howItWorks: "How it works",
  step1: "Choose a property and complete KYC",
  step2: "Pay in PKR from your bank",
  step3: "Tokens are issued to your wallet",
  step4: "Receive monthly rent in your bank",
  back: "All properties",
  chainUnavailable: "Live chain data is unavailable right now.",
  office: "Office",
  retail: "Retail",
};

const ur: typeof en = {
  brand: "پراپرٹی ٹوکن",
  navProperties: "جائیدادیں",
  navPortfolio: "پورٹ فولیو",
  navMarket: "مارکیٹ",
  demoBanner: "یہ مقامی ٹیسٹ نیٹ ورک پر ایک نمونہ ہے۔ صرف نمونہ جائیدادیں اور ٹیسٹ رقم۔ یہ پیشکش نہیں ہے۔",
  heroTitle: "بہترین جائیداد میں حصہ، صرف 5,000 روپے سے",
  heroBody:
    "ہر جائیداد ایک آزاد ٹرسٹی کے پاس ہوتی ہے۔ آپ کے ٹوکن ٹرسٹی کے رجسٹر کی عکاسی کرتے ہیں اور کرائے میں آپ کا حصہ روپوں میں آپ کے بینک میں آتا ہے۔",
  heroSafety: "ٹرسٹی کی ملکیت · صرف تصدیق شدہ سرمایہ کار · کرایہ آپ کے بینک میں",
  liveOnChain: "بلاک چین پر لائیو",
  comingSoon: "جلد آ رہا ہے",
  sample: "نمونہ جائیداد",
  pricePerToken: "فی ٹوکن قیمت",
  yield: "کرائے کی شرح",
  occupancy: "قبضہ",
  sold: "فروخت",
  viewProperty: "جائیداد دیکھیں",
  tokensIssued: "جاری ٹوکن",
  register: "ٹرسٹی رجسٹر",
  trading: "ٹریڈنگ",
  tradingLive: "جاری",
  tradingPaused: "معطل",
  area: "رقبہ",
  tenant: "کرایہ دار",
  city: "شہر",
  navChart: "فی ٹوکن قدر (روپے)",
  rentChart: "فی ٹوکن ماہانہ کرایہ (روپے)",
  sampleHistory: "وضاحت کے لیے نمونہ تاریخ",
  minInvestment: "کم از کم سرمایہ کاری",
  invest: "سرمایہ کاری کریں",
  investSoon: "سرمایہ کاری اگلے مرحلے میں کھلے گی",
  tokenContract: "ٹوکن کنٹریکٹ",
  verifyOnChain: "لائیو نشان والا ہر عدد اسی لمحے بلاک چین سے پڑھا جاتا ہے۔",
  howItWorks: "یہ کیسے کام کرتا ہے",
  step1: "جائیداد منتخب کریں اور KYC مکمل کریں",
  step2: "اپنے بینک سے روپوں میں ادائیگی کریں",
  step3: "ٹوکن آپ کے والٹ میں جاری ہوتے ہیں",
  step4: "ہر ماہ کرایہ اپنے بینک میں وصول کریں",
  back: "تمام جائیدادیں",
  chainUnavailable: "اس وقت لائیو بلاک چین ڈیٹا دستیاب نہیں۔",
  office: "دفتر",
  retail: "ریٹیل",
};

export type Dict = typeof en;

export function dictFor(lang: Lang): Dict {
  return lang === "ur" ? ur : en;
}

/** Picks the text for the current language from a bilingual value. */
export function loc(text: { en: string; ur: string }, lang: Lang): string {
  return lang === "ur" ? text.ur : text.en;
}

export function formatPkr(amount: number, lang: Lang): string {
  return new Intl.NumberFormat(lang === "ur" ? "ur-PK" : "en-PK", {
    style: "currency",
    currency: "PKR",
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatNumber(n: number | bigint, lang: Lang): string {
  return new Intl.NumberFormat(lang === "ur" ? "ur-PK" : "en-PK").format(n);
}
