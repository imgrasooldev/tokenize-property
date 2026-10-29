import type { Lang } from "./i18n";

/** Token-holder votes (migration 0046), English and Urdu. */
const en = {
  nav: "Votes",
  title: "Token-holder votes",
  intro: "You vote with the units you held at the record block. One vote per poll; it cannot be changed.",
  none: "There is no vote for the tokens you hold.",
  st_upcoming: "opens soon",
  st_open: "open",
  st_counting: "closed, being counted",
  st_closed: "result",
  weight: "Your units at block {b}: {w}",
  window: "{a} to {b} (PKT)",
  quorum: "Quorum {q} %",
  vote: "Vote",
  voted: "You voted: {o}",
  turnout: "Turnout {t} % · quorum {m}",
  met: "met",
  notMet: "not met",
  ok: "Your vote is recorded.",
  err_rate: "Too many requests. Please wait a minute.",
  err_closed: "This vote is not open, or you have already voted.",
  err_generic: "Something went wrong. Please try again.",
  err_stepup: "Confirm with your passkey to vote.",
};
export type VotesDict = typeof en;

const ur: VotesDict = {
  nav: "ووٹ",
  title: "ٹوکن ہولڈرز کی ووٹنگ",
  intro: "آپ ریکارڈ بلاک پر رکھے گئے یونٹس کے حساب سے ووٹ دیتے ہیں۔ ہر ووٹ میں ایک ہی بار؛ بعد میں بدلا نہیں جا سکتا۔",
  none: "آپ کے ٹوکنز کے لیے کوئی ووٹ نہیں ہے۔",
  st_upcoming: "جلد کھلے گا",
  st_open: "کھلا",
  st_counting: "بند، گنتی جاری",
  st_closed: "نتیجہ",
  weight: "بلاک {b} پر آپ کے یونٹس: {w}",
  window: "{a} سے {b} تک (پاکستانی وقت)",
  quorum: "کورم {q} فیصد",
  vote: "ووٹ دیں",
  voted: "آپ کا ووٹ: {o}",
  turnout: "شرکت {t} فیصد · کورم {m}",
  met: "پورا",
  notMet: "پورا نہیں",
  ok: "آپ کا ووٹ درج ہو گیا۔",
  err_rate: "بہت زیادہ درخواستیں۔ ایک منٹ انتظار کریں۔",
  err_closed: "یہ ووٹ کھلا نہیں، یا آپ پہلے ہی ووٹ دے چکے ہیں۔",
  err_generic: "کچھ غلط ہو گیا۔ دوبارہ کوشش کریں۔",
  err_stepup: "ووٹ دینے کے لیے اپنی پاس کی سے تصدیق کریں۔",
};

export function votesDict(lang: Lang): VotesDict {
  return lang === "ur" ? ur : en;
}

export function pollState(d: VotesDict, s: string): string {
  return s === "upcoming" ? d.st_upcoming : s === "counting" ? d.st_counting : s === "closed" ? d.st_closed : d.st_open;
}
