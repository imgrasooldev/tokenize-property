import type { Lang } from "./i18n";

/** Linking the mobile app (ADR 0018), English and Urdu. */
const en = {
  title: "Link the mobile app",
  intro: "Enter the code the Property Token app shows. Only approve a code you see on your own phone right now.",
  code: "Code from the app",
  approve: "Approve this device",
  deny: "This is not my phone",
  approved: "Approved: {d} is now signed in. You can close this page.",
  denied: "Denied: that device was not signed in.",
  err_input: "Enter the 8-letter code shown in the app, for example BCDF-GHJK.",
  err_code: "That code is unknown or expired. Ask the app for a new one.",
  err_rate: "Too many attempts. Please wait a minute.",
  err_generic: "Something went wrong. Please try again.",
  warning: "Never approve a code someone gave you by phone, SMS or e-mail. We never ask for it.",
  devices: "Linked devices",
  noDevices: "No mobile device is linked.",
  linked: "Linked",
  remove: "Sign out this device",
};
export type DeviceDict = typeof en;

const ur: DeviceDict = {
  title: "موبائل ایپ منسلک کریں",
  intro: "پراپرٹی ٹوکن ایپ میں دکھایا گیا کوڈ لکھیں۔ صرف وہی کوڈ منظور کریں جو اس وقت آپ کے اپنے فون پر نظر آ رہا ہو۔",
  code: "ایپ کا کوڈ",
  approve: "اس ڈیوائس کو منظور کریں",
  deny: "یہ میرا فون نہیں",
  approved: "منظور: {d} اب سائن اِن ہے۔ آپ یہ صفحہ بند کر سکتے ہیں۔",
  denied: "مسترد: وہ ڈیوائس سائن اِن نہیں ہوئی۔",
  err_input: "ایپ میں دکھایا گیا 8 حروف کا کوڈ لکھیں، مثلاً BCDF-GHJK۔",
  err_code: "یہ کوڈ نامعلوم ہے یا اس کی مدت ختم ہو گئی۔ ایپ سے نیا کوڈ لیں۔",
  err_rate: "بہت زیادہ کوششیں۔ براہ کرم ایک منٹ انتظار کریں۔",
  err_generic: "کچھ غلط ہو گیا۔ دوبارہ کوشش کریں۔",
  warning: "کبھی وہ کوڈ منظور نہ کریں جو کسی نے فون، ایس ایم ایس یا ای میل پر دیا ہو۔ ہم کبھی یہ کوڈ نہیں مانگتے۔",
  devices: "منسلک ڈیوائسز",
  noDevices: "کوئی موبائل ڈیوائس منسلک نہیں۔",
  linked: "منسلک",
  remove: "اس ڈیوائس سے سائن آؤٹ کریں",
};

export function deviceDict(lang: Lang): DeviceDict {
  return lang === "ur" ? ur : en;
}
