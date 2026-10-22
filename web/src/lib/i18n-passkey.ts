import type { Lang } from "./i18n";
import type { PasskeyError } from "./passkey-rules";

/** Texts of the investor passkey screens (T-030), English and Urdu. Placeholders: {d}, {o}. */
const en = {
  title: "Passkeys",
  intro: "Sign in with your fingerprint, face or device PIN instead of a password. A passkey works only on this website, so it cannot be phished.",
  signIn: "Sign in with passkey",
  signingIn: "Confirm on your device…",
  unavailable: "Passkeys need the secure domain; available after the domain + TLS go live. Use the demo sign-in meanwhile.",
  wrongHost: "Passkeys work only at {o}. Open the site there to use them.",
  unsupported: "This browser does not support passkeys.",
  none: "You have no passkey yet.",
  added: "Added {d}",
  lastUsed: "Last used {d}",
  neverUsed: "Not used yet",
  synced: "Synced passkey",
  deviceBound: "Device-bound passkey",
  thisSession: "Used for this session",
  remove: "Remove",
  confirmRemove: "Confirm removal",
  removing: "Removing…",
  removed: "Passkey removed.",
  nameLabel: "Passkey name",
  namePlaceholder: "e.g. My phone",
  add: "Add a passkey",
  adding: "Follow your device's prompt…",
  addedOk: "Passkey added.",
  stepUpBtn: "Confirm with passkey",
  stepUpBusy: "Confirm on your device…",
  stepUpNeeded: "This action needs a fresh passkey confirmation.",
  enrolNeeded: "This action needs a passkey. Add one in your account first.",
  goAccount: "Open my account",
  sessionNote: "Sessions end after 30 minutes without activity and after 12 hours.",
  stepUpNote: "Cancelling a reservation and reserving PKR 100,000 or more ask for your passkey again.",
  err_unavailable: "Passkeys need the secure domain; available after the domain + TLS go live.",
  err_unsupported: "This browser does not support passkeys.",
  err_cancelled: "The passkey request was cancelled or timed out.",
  err_rate: "Too many attempts. Please wait a minute and try again.",
  err_session: "Your session has ended. Please sign in again.",
  err_reauth: "For your safety, sign in again and add your first passkey within 10 minutes.",
  err_reauthStepUp: "Confirm with one of your passkeys first.",
  err_limit: "You already have 10 passkeys. Remove one first.",
  err_locked: "Too many failed attempts. Please try again in 15 minutes.",
  err_busy: "Too many attempts are open. Please try again in a moment.",
  err_none: "Add a passkey first.",
  err_expired: "This attempt expired. Please try again.",
  err_verify: "The passkey's answer could not be verified.",
  err_refused: "This passkey is not registered here, was removed, or cannot be used.",
  err_name: "Name: letters, numbers and spaces, up to 40 characters.",
  err_duplicate: "This passkey is already registered.",
  err_stepup: "Confirm with your passkey to continue.",
  err_unknown: "Passkey not found.",
  err_generic: "Something went wrong. Please try again.",
};

export type PasskeyDict = typeof en;

const ur: PasskeyDict = {
  title: "پاس کیز",
  intro: "پاس ورڈ کے بجائے اپنے فنگر پرنٹ، چہرے یا ڈیوائس PIN سے سائن ان کریں۔ پاس کی صرف اسی ویب سائٹ پر کام کرتی ہے، اس لیے اسے فشنگ سے چرایا نہیں جا سکتا۔",
  signIn: "پاس کی سے سائن ان",
  signingIn: "اپنے آلے پر تصدیق کریں…",
  unavailable: "پاس کیز کے لیے محفوظ ڈومین درکار ہے؛ ڈومین اور TLS فعال ہونے کے بعد دستیاب ہوں گی۔ تب تک ڈیمو سائن ان استعمال کریں۔",
  wrongHost: "پاس کیز صرف {o} پر کام کرتی ہیں۔ انہیں استعمال کرنے کے لیے سائٹ وہاں کھولیں۔",
  unsupported: "یہ براؤزر پاس کیز کی سہولت نہیں دیتا۔",
  none: "آپ کی ابھی کوئی پاس کی نہیں ہے۔",
  added: "شامل کی گئی {d}",
  lastUsed: "آخری استعمال {d}",
  neverUsed: "ابھی استعمال نہیں ہوئی",
  synced: "ہم آہنگ (synced) پاس کی",
  deviceBound: "آلے سے منسلک پاس کی",
  thisSession: "اس سیشن کے لیے استعمال ہوئی",
  remove: "ہٹائیں",
  confirmRemove: "ہٹانے کی تصدیق کریں",
  removing: "ہٹائی جا رہی ہے…",
  removed: "پاس کی ہٹا دی گئی۔",
  nameLabel: "پاس کی کا نام",
  namePlaceholder: "مثلاً میرا فون",
  add: "پاس کی شامل کریں",
  adding: "اپنے آلے کی ہدایات پر عمل کریں…",
  addedOk: "پاس کی شامل ہو گئی۔",
  stepUpBtn: "پاس کی سے تصدیق کریں",
  stepUpBusy: "اپنے آلے پر تصدیق کریں…",
  stepUpNeeded: "اس کام کے لیے پاس کی سے تازہ تصدیق درکار ہے۔",
  enrolNeeded: "اس کام کے لیے پاس کی درکار ہے۔ پہلے اپنے اکاؤنٹ میں ایک پاس کی شامل کریں۔",
  goAccount: "میرا اکاؤنٹ کھولیں",
  sessionNote: "سیشن 30 منٹ کی غیر فعالیت کے بعد اور 12 گھنٹے بعد ختم ہو جاتا ہے۔",
  stepUpNote: "ریزرویشن منسوخ کرنے اور 1,00,000 روپے یا زیادہ کی ریزرویشن پر دوبارہ پاس کی مانگی جاتی ہے۔",
  err_unavailable: "پاس کیز کے لیے محفوظ ڈومین درکار ہے؛ ڈومین اور TLS فعال ہونے کے بعد دستیاب ہوں گی۔",
  err_unsupported: "یہ براؤزر پاس کیز کی سہولت نہیں دیتا۔",
  err_cancelled: "پاس کی کی درخواست منسوخ ہو گئی یا اس کا وقت ختم ہو گیا۔",
  err_rate: "بہت زیادہ کوششیں۔ ایک منٹ انتظار کر کے دوبارہ کوشش کریں۔",
  err_session: "آپ کا سیشن ختم ہو گیا ہے۔ دوبارہ سائن ان کریں۔",
  err_reauth: "اپنی حفاظت کے لیے دوبارہ سائن ان کریں اور 10 منٹ کے اندر اپنی پہلی پاس کی شامل کریں۔",
  err_reauthStepUp: "پہلے اپنی کسی پاس کی سے تصدیق کریں۔",
  err_limit: "آپ کی پہلے ہی 10 پاس کیز ہیں۔ پہلے ایک ہٹائیں۔",
  err_locked: "بہت سی ناکام کوششیں۔ 15 منٹ بعد دوبارہ کوشش کریں۔",
  err_busy: "بہت سی کوششیں جاری ہیں۔ تھوڑی دیر بعد دوبارہ کوشش کریں۔",
  err_none: "پہلے ایک پاس کی شامل کریں۔",
  err_expired: "اس کوشش کا وقت ختم ہو گیا۔ دوبارہ کوشش کریں۔",
  err_verify: "پاس کی کے جواب کی تصدیق نہیں ہو سکی۔",
  err_refused: "یہ پاس کی یہاں رجسٹرڈ نہیں، ہٹا دی گئی ہے، یا استعمال نہیں ہو سکتی۔",
  err_name: "نام: حروف، اعداد اور خالی جگہ، زیادہ سے زیادہ 40 حروف۔",
  err_duplicate: "یہ پاس کی پہلے سے رجسٹرڈ ہے۔",
  err_stepup: "جاری رکھنے کے لیے اپنی پاس کی سے تصدیق کریں۔",
  err_unknown: "پاس کی نہیں ملی۔",
  err_generic: "کچھ غلط ہو گیا۔ دوبارہ کوشش کریں۔",
};

export function passkeyDict(lang: Lang): PasskeyDict {
  return lang === "ur" ? ur : en;
}

/** The message for an error key (every PasskeyError has one in both languages: checked by the types and a test). */
export function passkeyError(d: PasskeyDict, key: PasskeyError): string {
  const k = `err_${key}` as const;
  // eslint-disable-next-line security/detect-object-injection -- k is built from the closed PasskeyError union
  return d[k];
}

export const PASSKEY_DICTS = { en, ur };
