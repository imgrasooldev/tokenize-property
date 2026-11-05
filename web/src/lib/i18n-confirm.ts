import type { Lang } from "./i18n";

/** Confirming a reservation the mobile app asked for (ADR 0018 amendment 1), English and Urdu. */
const en = {
  title: "Confirm from the app",
  intro: "The Property Token app asked to reserve units for you. Check the details, accept the documents and confirm. Nothing is reserved until you do.",
  code: "Code from the app",
  find: "Show the request",
  notFound: "That code is unknown, expired or not yours. Ask the app for a new request.",
  offering: "Offering",
  units: "Units",
  amount: "Amount",
  expires: "Confirm before",
  decline: "I did not ask for this",
  declined: "Declined. Nothing was reserved.",
  done: "Confirmed. Your reservation is on My subscriptions and the app now shows how to pay.",
  bindFailed: "Your reservation was made, but it could not be linked to the app request. You can still pay from My subscriptions.",
  warning: "Only confirm a request you made yourself in the app just now. We never ask you to confirm by phone, SMS or e-mail.",
};
export type ConfirmDict = typeof en;

const ur: ConfirmDict = {
  title: "ایپ سے تصدیق",
  intro: "پراپرٹی ٹوکن ایپ نے آپ کے لیے یونٹ ریزرو کرنے کی درخواست کی ہے۔ تفصیل دیکھیں، دستاویزات قبول کریں اور تصدیق کریں۔ آپ کی تصدیق کے بغیر کچھ ریزرو نہیں ہوتا۔",
  code: "ایپ کا کوڈ",
  find: "درخواست دکھائیں",
  notFound: "یہ کوڈ نامعلوم، ختم شدہ یا آپ کا نہیں۔ ایپ سے نئی درخواست بنائیں۔",
  offering: "پیشکش",
  units: "یونٹ",
  amount: "رقم",
  expires: "اس سے پہلے تصدیق کریں",
  decline: "میں نے یہ درخواست نہیں کی",
  declined: "مسترد۔ کچھ ریزرو نہیں ہوا۔",
  done: "تصدیق ہو گئی۔ آپ کی ریزرویشن میری سبسکرپشنز میں ہے اور ایپ اب ادائیگی کا طریقہ دکھاتی ہے۔",
  bindFailed: "آپ کی ریزرویشن ہو گئی، لیکن ایپ کی درخواست سے جڑ نہ سکی۔ آپ پھر بھی میری سبسکرپشنز سے ادائیگی کر سکتے ہیں۔",
  warning: "صرف وہی درخواست تصدیق کریں جو آپ نے ابھی خود ایپ میں کی ہو۔ ہم کبھی فون، ایس ایم ایس یا ای میل پر تصدیق نہیں مانگتے۔",
};

export function confirmDict(lang: Lang): ConfirmDict {
  return lang === "ur" ? ur : en;
}
