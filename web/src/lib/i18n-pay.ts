import type { Lang } from "./i18n";

/** The tenant's rent payment page (migration 0044), English and Urdu. */
const en = {
  title: "Rent payment",
  intro: "Pay this rent by bank transfer or Raast. Put the reference below in the payment narration so the trustee can match it.",
  tenant: "For",
  period: "Rent month",
  amount: "Amount",
  due: "Due",
  reference: "Payment reference",
  account: "Pay to",
  status: "Status",
  st_open: "waiting for payment",
  st_proposed: "payment received, being checked",
  st_paid: "paid, thank you",
  notFound: "This payment link is not valid or was cancelled. Please ask the property manager for a new one.",
  note: "Pay exactly this amount. Never share bank passwords, PINs or one-time codes with anyone; we never ask for them.",
};
export type PayDict = typeof en;

const ur: PayDict = {
  title: "کرائے کی ادائیگی",
  intro: "یہ کرایہ بینک ٹرانسفر یا راست سے ادا کریں۔ ادائیگی کی تفصیل میں نیچے دیا گیا حوالہ لکھیں تاکہ ٹرسٹی اسے ملا سکے۔",
  tenant: "برائے",
  period: "کرائے کا مہینہ",
  amount: "رقم",
  due: "آخری تاریخ",
  reference: "ادائیگی کا حوالہ",
  account: "اس اکاؤنٹ میں ادا کریں",
  status: "صورتحال",
  st_open: "ادائیگی کا انتظار",
  st_proposed: "ادائیگی موصول، جانچ جاری",
  st_paid: "ادا شدہ، شکریہ",
  notFound: "یہ ادائیگی کا لنک درست نہیں یا منسوخ ہو چکا ہے۔ براہ کرم پراپرٹی مینیجر سے نیا لنک لیں۔",
  note: "بالکل یہی رقم ادا کریں۔ بینک پاس ورڈ، پن یا ایک بار کے کوڈ کبھی کسی کو نہ بتائیں؛ ہم کبھی نہیں مانگتے۔",
};

export function payDict(lang: Lang): PayDict {
  return lang === "ur" ? ur : en;
}

export function statusLabel(d: PayDict, status: string): string {
  return status === "paid" ? d.st_paid : status === "proposed" ? d.st_proposed : d.st_open;
}
