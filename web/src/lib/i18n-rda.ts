import type { Lang } from "./i18n";

/** Spec S-08: Roshan Digital Account investors (Pakistanis living abroad), English and Urdu. */
const en = {
  abroad: "I live outside Pakistan (Roshan Digital Account)",
  abroadHint: "Pakistanis abroad invest from their own Roshan Digital Account (RDA). Payments come only from it and rent and proceeds go back only to it.",
  document: "Identity document",
  nicop: "NICOP",
  poc: "POC (Pakistan Origin Card)",
  documentHint: "Enter the 13-digit number of your NICOP or POC in the CNIC field above.",
  country: "Country you live in",
  countryPick: "Choose a country",
  errCountry: "Choose the country you live in.",
  residency: "Residency",
  resident: "Pakistan",
  livesAbroad: "Lives in {c} · {d}",
  rdaNote: "Rent, refunds and sale proceeds go only to your Roshan Digital Account. Pay for investments only from it.",
  rdaMissing: "Add your Roshan Digital Account as payout account to receive rent.",
  investRda: "You live outside Pakistan: pay only from your Roshan Digital Account. A payment from any other account is returned.",
};
export type RdaDict = typeof en;

const ur: RdaDict = {
  abroad: "میں پاکستان سے باہر رہتا/رہتی ہوں (روشن ڈیجیٹل اکاؤنٹ)",
  abroadHint: "بیرونِ ملک پاکستانی اپنے روشن ڈیجیٹل اکاؤنٹ (RDA) سے سرمایہ کاری کرتے ہیں۔ ادائیگی صرف اسی سے آتی ہے اور کرایہ اور رقوم صرف اسی میں واپس جاتی ہیں۔",
  document: "شناختی دستاویز",
  nicop: "نائیکوپ (NICOP)",
  poc: "پی او سی (پاکستان اوریجن کارڈ)",
  documentHint: "اوپر شناختی کارڈ والے خانے میں اپنے نائیکوپ یا پی او سی کا 13 ہندسوں کا نمبر لکھیں۔",
  country: "آپ کس ملک میں رہتے ہیں",
  countryPick: "ملک منتخب کریں",
  errCountry: "وہ ملک منتخب کریں جہاں آپ رہتے ہیں۔",
  residency: "رہائش",
  resident: "پاکستان",
  livesAbroad: "{c} میں مقیم · {d}",
  rdaNote: "کرایہ، رقم کی واپسی اور فروخت کی رقم صرف آپ کے روشن ڈیجیٹل اکاؤنٹ میں جاتی ہے۔ سرمایہ کاری کی ادائیگی صرف اسی سے کریں۔",
  rdaMissing: "کرایہ وصول کرنے کے لیے اپنا روشن ڈیجیٹل اکاؤنٹ وصولی اکاؤنٹ کے طور پر شامل کریں۔",
  investRda: "آپ پاکستان سے باہر رہتے ہیں: ادائیگی صرف اپنے روشن ڈیجیٹل اکاؤنٹ سے کریں۔ کسی اور اکاؤنٹ سے آئی رقم واپس کر دی جاتی ہے۔",
};

export function rdaDict(lang: Lang): RdaDict {
  return lang === "ur" ? ur : en;
}

/** ISO 3166-1 numeric codes of the countries most Pakistanis abroad live in (the sign-up list). */
export const COUNTRIES: readonly { code: number; en: string; ur: string }[] = [
  { code: 784, en: "United Arab Emirates", ur: "متحدہ عرب امارات" },
  { code: 682, en: "Saudi Arabia", ur: "سعودی عرب" },
  { code: 826, en: "United Kingdom", ur: "برطانیہ" },
  { code: 840, en: "United States", ur: "امریکہ" },
  { code: 124, en: "Canada", ur: "کینیڈا" },
  { code: 36, en: "Australia", ur: "آسٹریلیا" },
  { code: 634, en: "Qatar", ur: "قطر" },
  { code: 414, en: "Kuwait", ur: "کویت" },
  { code: 512, en: "Oman", ur: "عمان" },
  { code: 48, en: "Bahrain", ur: "بحرین" },
  { code: 276, en: "Germany", ur: "جرمنی" },
  { code: 380, en: "Italy", ur: "اٹلی" },
  { code: 724, en: "Spain", ur: "سپین" },
  { code: 528, en: "Netherlands", ur: "نیدرلینڈز" },
  { code: 752, en: "Sweden", ur: "سویڈن" },
  { code: 578, en: "Norway", ur: "ناروے" },
  { code: 458, en: "Malaysia", ur: "ملائیشیا" },
  { code: 156, en: "China", ur: "چین" },
  { code: 392, en: "Japan", ur: "جاپان" },
  { code: 554, en: "New Zealand", ur: "نیوزی لینڈ" },
];

export function countryName(code: number | null, lang: Lang): string {
  const c = COUNTRIES.find((x) => x.code === code);
  return c ? (lang === "ur" ? c.ur : c.en) : code === null ? "" : String(code);
}
