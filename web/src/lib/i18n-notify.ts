import type { Lang } from "./i18n";

/** Texts of the investor notification centre (T-028, migration 0030), English and Urdu. Placeholders: {n}. */
const en = {
  nav: "Notifications",
  title: "Notifications",
  intro: "Everything we tell you about your account, investments and security, in one place. Messages never contain links: open the app yourself.",
  unreadLabel: "{n} unread",
  none: "No notifications yet.",
  noKyc: "Notifications start once your identity is verified.",
  loadError: "Notifications could not be loaded just now. Please try again in a moment.",
  markRead: "Mark as read",
  markAllRead: "Mark all as read",
  newChip: "New",
  security: "Security",
  offer: "Offer",
  allTimesPkt: "Times are Pakistan time (PKT, UTC+5).",
  // settings
  settingsTitle: "Message settings",
  language: "Language of SMS and e-mail",
  langEn: "English",
  langUr: "Urdu",
  updatesTitle: "Account and investment updates",
  updatesNote: "Payments, reservations, units, rent and refunds. They always appear here; you choose whether they also come by SMS or e-mail.",
  bySms: "By SMS",
  byEmail: "By e-mail",
  securityNote: "Security alerts (sign-ins, passkeys, payout account changes) always come by every channel on file and cannot be switched off.",
  offersTitle: "News about new offerings (optional)",
  offersConsent:
    "I agree to receive news about new property offerings from Property Token on the channels I tick. Investing carries risk; every offering has its own document. I can withdraw this at any time here.",
  contactsTitle: "Phone and e-mail on file",
  onFile: "on file",
  notOnFile: "not on file",
  contactsNote: "Adding or changing a phone number or e-mail address needs a one-time code; it comes with the SMS and e-mail provider.",
  save: "Save settings",
  saved: "Settings saved.",
  err_rate: "Too many changes. Please wait a minute.",
  err_invalid: "These settings could not be saved. Please check them.",
  err_generic: "Something went wrong. Please try again.",
};

export type NotifyDict = typeof en;

const ur: NotifyDict = {
  nav: "اطلاعات",
  title: "اطلاعات",
  intro: "آپ کے اکاؤنٹ، سرمایہ کاری اور حفاظت کے بارے میں ہماری ہر اطلاع ایک جگہ۔ پیغامات میں کبھی لنک نہیں ہوتے: ایپ خود کھولیں۔",
  unreadLabel: "{n} نہ پڑھی گئیں",
  none: "ابھی کوئی اطلاع نہیں۔",
  noKyc: "شناخت کی تصدیق کے بعد اطلاعات شروع ہوں گی۔",
  loadError: "اطلاعات ابھی لوڈ نہیں ہو سکیں۔ تھوڑی دیر بعد دوبارہ کوشش کریں۔",
  markRead: "پڑھ لیا",
  markAllRead: "سب پڑھ لیں",
  newChip: "نئی",
  security: "حفاظت",
  offer: "پیشکش",
  allTimesPkt: "اوقات پاکستان کے وقت (PKT، UTC+5) میں ہیں۔",
  settingsTitle: "پیغامات کی ترتیبات",
  language: "ایس ایم ایس اور ای میل کی زبان",
  langEn: "انگریزی",
  langUr: "اردو",
  updatesTitle: "اکاؤنٹ اور سرمایہ کاری کی اطلاعات",
  updatesNote: "ادائیگیاں، بکنگ، یونٹس، کرایہ اور رقم کی واپسی۔ یہ ہمیشہ یہاں نظر آتی ہیں؛ آپ چنتے ہیں کہ ایس ایم ایس یا ای میل سے بھی آئیں یا نہیں۔",
  bySms: "ایس ایم ایس سے",
  byEmail: "ای میل سے",
  securityNote: "حفاظتی اطلاعات (لاگ اِن، پاس کیز، بینک اکاؤنٹ کی تبدیلی) ہمیشہ ہر موجود ذریعے سے آتی ہیں اور بند نہیں کی جا سکتیں۔",
  offersTitle: "نئی آفرنگز کی خبریں (اختیاری)",
  offersConsent:
    "میں منتخب کردہ ذرائع پر پراپرٹی ٹوکن سے نئی جائیداد آفرنگز کی خبریں لینے پر رضامند ہوں۔ سرمایہ کاری میں خطرہ ہے؛ ہر آفرنگ کی اپنی دستاویز ہے۔ میں کسی بھی وقت یہاں سے یہ رضامندی واپس لے سکتا/سکتی ہوں۔",
  contactsTitle: "موجود فون اور ای میل",
  onFile: "موجود",
  notOnFile: "موجود نہیں",
  contactsNote: "فون نمبر یا ای میل شامل کرنے یا بدلنے کے لیے ایک بار کا کوڈ درکار ہے؛ یہ ایس ایم ایس اور ای میل فراہم کنندہ کے ساتھ آئے گا۔",
  save: "ترتیبات محفوظ کریں",
  saved: "ترتیبات محفوظ ہو گئیں۔",
  err_rate: "بہت زیادہ تبدیلیاں۔ ایک منٹ انتظار کریں۔",
  err_invalid: "یہ ترتیبات محفوظ نہیں ہو سکیں۔ دوبارہ دیکھیں۔",
  err_generic: "کچھ غلط ہو گیا۔ دوبارہ کوشش کریں۔",
};

export function notifyDict(lang: Lang): NotifyDict {
  return lang === "ur" ? ur : en;
}

/** Version of the marketing consent text above (stored with every opt-in, migration 0030 NP-5). Change it when the text changes. */
export const MARKETING_CONSENT_VERSION = "mkt-2026-10";
