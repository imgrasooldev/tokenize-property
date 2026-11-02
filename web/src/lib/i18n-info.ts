import type { Lang } from "./i18n";

/**
 * Public information pages (terms, privacy, risks, fees, FAQ, about, reports, contact), English and
 * Urdu. Legal wording is a DRAFT for the prototype until counsel and the SECP sandbox approve it; every
 * page that carries legal text says so. Facts about the platform match docs/PORTALS.md and the code.
 */
export type InfoKey = "terms" | "privacy" | "risks" | "fees" | "faq" | "about" | "reports" | "contact";

export interface InfoSection {
  h: string;
  p?: string[];
  list?: string[];
}

export interface InfoPage {
  kicker: string;
  title: string;
  intro: string;
  draft: boolean;
  sections: InfoSection[];
}

export interface InfoChrome {
  draft: string;
  updated: string;
  footLegal: string;
  footHelp: string;
  names: Record<InfoKey, string>;
}

const enChrome: InfoChrome = {
  draft: "Draft for the prototype. This text has not yet been approved by our lawyers or the regulator and will change before the platform opens to real investors.",
  updated: "Last updated: 3 November 2026",
  footLegal: "Legal",
  footHelp: "Help",
  names: { terms: "Terms of use", privacy: "Privacy notice", risks: "Risk disclosure", fees: "Fees and tax", faq: "FAQ", about: "About us", reports: "Audit and Shariah reports", contact: "Contact and complaints" },
};

const urChrome: InfoChrome = {
  draft: "پروٹوٹائپ کا مسودہ۔ یہ متن ابھی ہمارے وکلاء یا ریگولیٹر سے منظور نہیں ہوا اور حقیقی سرمایہ کاروں کے لیے پلیٹ فارم کھلنے سے پہلے بدلے گا۔",
  updated: "آخری تبدیلی: 3 نومبر 2026",
  footLegal: "قانونی",
  footHelp: "مدد",
  names: { terms: "شرائطِ استعمال", privacy: "رازداری کا نوٹس", risks: "خطرات کا انکشاف", fees: "فیس اور ٹیکس", faq: "عام سوالات", about: "ہمارے بارے میں", reports: "آڈٹ اور شریعہ رپورٹس", contact: "رابطہ اور شکایات" },
};

const en: Record<InfoKey, InfoPage> = {
  terms: {
    kicker: "LEGAL",
    title: "Terms of use",
    intro: "These terms apply when you use the Property Token website and app. By creating an account you accept them.",
    draft: true,
    sections: [
      { h: "1. Who we are", p: ["Property Token is a platform that lets verified investors in Pakistan buy units of income-producing property held in trust. The property is held by an independent trustee; units are recorded as security tokens on our permissioned blockchain."] },
      { h: "2. Prototype status", p: ["The platform is a working prototype. It is not yet licensed and is not open to real investors or real money. Figures, properties and payments on the demo server are samples."] },
      {
        h: "3. Your account",
        list: [
          "You must be 18 or older, a verified individual and use your own name, CNIC, mobile number and bank account.",
          "You sign in with a passkey (fingerprint, face or security key). Keep your devices safe; tell us at once if one is lost.",
          "You may not act for another person, use another person's money or try to get around our checks.",
        ],
      },
      {
        h: "4. Investing",
        list: [
          "You invest by subscribing to an offering and paying from your own bank account. Units are issued after the trustee receives the money.",
          "You may withdraw a subscription for a full refund within the cooling-off period shown in the offering.",
          "Rent is distributed after costs, fees and withholding tax, to your own verified bank account.",
          "Selling or transferring units is possible only as the offering documents allow; there may be no buyer.",
        ],
      },
      { h: "5. Information, not advice", p: ["Content on the platform, including the AI analyst, is information only. It is not investment, legal or tax advice. Decide for yourself or ask an adviser."] },
      { h: "6. Records", p: ["Our ledger, the trustee register and the blockchain record are the records of your holdings. We may correct an obvious error with the trustee's approval and tell you."] },
      { h: "7. Suspension", p: ["We may suspend an account or hold a payment where the law requires it, for example during an anti-money-laundering review, or to protect investors."] },
      { h: "8. Complaints and disputes", p: ["Use the complaints page first. If you are not satisfied you may take the matter to the regulator's complaint service. Pakistani law applies."] },
    ],
  },
  privacy: {
    kicker: "LEGAL",
    title: "Privacy notice",
    intro: "What we collect, why, how long we keep it and your rights. We collect the least we can and never sell your data.",
    draft: true,
    sections: [
      {
        h: "What we collect",
        list: [
          "Identity: name, CNIC, date of birth, a liveness check, checked against NADRA.",
          "Contact: mobile number and email for alerts.",
          "Money: your payout bank account and the payments you make and receive.",
          "Suitability: income band, source of funds and investment experience.",
          "Technical: sign-in records and passkey public keys (never your fingerprint or face).",
        ],
      },
      {
        h: "How we protect it",
        list: [
          "Your full CNIC and phone number are not stored in our main database: only the last digits and a one-way fingerprint.",
          "Names, addresses and documents are encrypted; each file has its own key.",
          "Staff see only what their role needs and sign in with hardware security keys; every access to sensitive data is logged.",
        ],
      },
      { h: "Why we use it", p: ["To verify you as the law requires (anti-money-laundering and know-your-customer rules), to run your investments and pay you, to meet tax duties, to keep the platform safe and to answer your questions."] },
      { h: "Who we share it with", p: ["NADRA and screening providers for checks, the trustee bank for payments, the Federal Board of Revenue for tax, and regulators or the Financial Monitoring Unit when the law requires. We never sell or rent your data."] },
      { h: "How long we keep it", p: ["Identity and transaction records are kept for the period the anti-money-laundering law requires after your account closes (to be confirmed), then deleted."] },
      { h: "Your rights", p: ["You may ask for a copy of your data, ask us to correct it, or close your account. Some records must be kept by law even after you close it. Contact us through the complaints page."] },
    ],
  },
  risks: {
    kicker: "BEFORE YOU INVEST",
    title: "Risk disclosure",
    intro: "Property can lose value and rent can stop. Read these risks before you invest, and only invest money you will not need soon.",
    draft: true,
    sections: [
      {
        h: "Main risks",
        list: [
          "Value: the property's value may fall. You may get back less than you invested.",
          "Income: tenants may leave or not pay; rent may be lower or late. Rent is not guaranteed.",
          "Liquidity: units can be hard to sell. Exit is possible only in the windows and on the terms of the offering, and there may be no buyer.",
          "Concentration: each offering is one property. Spread your money across several.",
          "Costs and tax: repairs, management fees and taxes reduce what you receive; tax rules can change.",
          "Legal and regulatory: laws, the regulator's rules or the property's legal status can change and affect your investment.",
          "Technology: the platform, the blockchain or a service provider could fail or be attacked. We use strong safeguards, but no system is risk-free.",
          "Platform: if the platform closes, the trustee still holds the property for unit holders, but payouts and sales may be delayed.",
        ],
      },
      { h: "What protects you", list: ["An independent trustee holds the property and the money, not the platform.", "Every payment and payout needs two people (maker-checker).", "Your holdings and rent can be checked by anyone on the verification page.", "You can withdraw within the cooling-off period."] },
      { h: "Each offering", p: ["Every offering has its own risk disclosure and offering document. You must read and accept them before you invest."] },
    ],
  },
  fees: {
    kicker: "COSTS",
    title: "Fees and tax",
    intro: "What you pay and what is deducted. The figures below are examples for the prototype until the fee schedule is approved.",
    draft: true,
    sections: [
      {
        h: "Fees (to be confirmed)",
        list: [
          "Opening an account: free.",
          "Investing: no platform fee on the subscription; the offering may include issue costs, shown before you invest.",
          "Property management: paid from rent before it is distributed; shown in each payout's calculation.",
          "Exit / redemption: a fee per the offering, shown before you confirm.",
          "Transfers between investors: a small fee, shown before you confirm.",
        ],
      },
      {
        h: "Tax",
        list: [
          "Withholding tax is deducted from rent at the rate the law sets (filer and non-filer rates differ). You get a tax certificate for your return.",
          "Capital gains on selling units are taxed under the rules that apply to you.",
          "Rates shown on the platform are placeholders until confirmed with our tax advisers.",
        ],
      },
      { h: "No hidden costs", p: ["Every deduction is in the payout calculation, which you can check against the on-chain record."] },
    ],
  },
  faq: {
    kicker: "HELP",
    title: "Frequently asked questions",
    intro: "Short answers to what investors ask most.",
    draft: false,
    sections: [
      { h: "What do I own?", p: ["Units of a trust that owns one property. The units are security tokens recorded on our blockchain and in the trustee's register."] },
      { h: "How much do I need to start?", p: ["Each offering shows its minimum, usually from about Rs 1,000 per unit."] },
      { h: "How do I pay?", p: ["By Raast or bank transfer from your own bank account to the trustee's collection account, with the reference shown. Payments from someone else's account are returned."] },
      { h: "When do I get rent?", p: ["Rent is distributed on the schedule of each offering, usually monthly, to your verified bank account after costs and withholding tax."] },
      { h: "Can I change my mind?", p: ["Yes, within the cooling-off period of the offering you can withdraw your subscription and get a full refund."] },
      { h: "How do I sell?", p: ["In the exit windows of the offering (sale back to the trust at the net asset value) or, where allowed, by transfer to another verified investor."] },
      { h: "Why no password?", p: ["Passkeys (fingerprint, face or a security key) cannot be phished or reused. Money actions ask for the passkey again."] },
      { h: "Is it Shariah compliant?", p: ["Offerings marked Shariah screened have a Shariah certificate; check each offering."] },
      { h: "How do I know my units are real?", p: ["Use the verification page: anyone can check token supply against the trustee register, document hashes and your rent entitlement."] },
      { h: "What if I lose my phone?", p: ["Your units are tied to your verified identity, not your phone. Recover access with a new identity check; payouts to a new bank account wait 72 hours."] },
    ],
  },
  about: {
    kicker: "ABOUT",
    title: "About Property Token",
    intro: "We let more Pakistanis own a share of income-producing property, with proof at every step.",
    draft: true,
    sections: [
      { h: "How it is built", list: ["An independent trustee holds each property and the money.", "Units are ERC-3643 security tokens on a private, permissioned blockchain; their state is anchored to a public chain every 15 minutes.", "Every money or token action needs two people and is written to an append-only, hash-chained ledger.", "Investors sign in with passkeys; staff with hardware security keys."] },
      { h: "Status", p: ["Prototype. We are preparing for the SECP regulatory sandbox. The trustee agreement, licences and audits are still being completed; until then the platform is not open to real investors."] },
      { h: "Licences and partners", p: ["Licence numbers, the trustee bank and the auditors will be listed here once confirmed."] },
    ],
  },
  reports: {
    kicker: "TRUST",
    title: "Audit and Shariah reports",
    intro: "Independent reports will be published here, each with its SHA-256 so you can check the file.",
    draft: false,
    sections: [
      { h: "Smart contract audits", p: ["Two independent audits of our contracts are planned before launch. Not yet published."] },
      { h: "Security test", p: ["An external penetration test is planned before launch. Not yet published."] },
      { h: "Financial statements", p: ["Audited statements of each trust will be published yearly."] },
      { h: "Shariah certificates", p: ["Each Shariah-screened offering shows its certificate on the property page; the platform's Shariah board certificate will be published here."] },
    ],
  },
  contact: {
    kicker: "HELP",
    title: "Contact and complaints",
    intro: "We are here to help. For anything about your account, sign in and use your support reference so we can find you without asking for your CNIC.",
    draft: true,
    sections: [
      { h: "Questions", p: ["Sign in and open Account: your support reference is shown there. Give it when you contact support."] },
      { h: "Complaints", list: ["Sign in and open Complaints to file one; you get a reference (CMP-…).", "We acknowledge within 2 working days and aim to resolve within 15 (to be confirmed).", "If you are not satisfied, you may take it to the regulator's complaint service."] },
      { h: "Security", p: ["We never ask for your passkey, a code or your full CNIC by phone, SMS or email. Report anything suspicious through Complaints."] },
    ],
  },
};

const ur: Record<InfoKey, InfoPage> = {
  terms: {
    kicker: "قانونی",
    title: "شرائطِ استعمال",
    intro: "یہ شرائط پراپرٹی ٹوکن کی ویب سائٹ اور ایپ کے استعمال پر لاگو ہیں۔ اکاؤنٹ بنا کر آپ انہیں قبول کرتے ہیں۔",
    draft: true,
    sections: [
      { h: "1۔ ہم کون ہیں", p: ["پراپرٹی ٹوکن ایک پلیٹ فارم ہے جو پاکستان میں تصدیق شدہ سرمایہ کاروں کو ٹرسٹ میں رکھی گئی آمدنی والی جائیداد کے یونٹ خریدنے دیتا ہے۔ جائیداد ایک آزاد ٹرسٹی کے پاس ہوتی ہے؛ یونٹ ہمارے اجازت یافتہ بلاک چین پر سیکیورٹی ٹوکن کے طور پر درج ہوتے ہیں۔"] },
      { h: "2۔ پروٹوٹائپ", p: ["پلیٹ فارم ایک چلتا ہوا پروٹوٹائپ ہے۔ ابھی لائسنس یافتہ نہیں اور حقیقی سرمایہ کاروں یا حقیقی رقم کے لیے کھلا نہیں۔ ڈیمو سرور پر اعداد، جائیدادیں اور ادائیگیاں نمونہ ہیں۔"] },
      { h: "3۔ آپ کا اکاؤنٹ", list: ["آپ کی عمر 18 سال یا زیادہ ہو، آپ تصدیق شدہ فرد ہوں اور اپنا نام، شناختی کارڈ، موبائل نمبر اور بینک اکاؤنٹ استعمال کریں۔", "آپ پاس کی (فنگر پرنٹ، چہرہ یا سیکیورٹی کی) سے سائن ان کرتے ہیں۔ اپنے آلات محفوظ رکھیں؛ گم ہونے پر فوراً بتائیں۔", "آپ کسی اور کی طرف سے کام، کسی اور کی رقم کا استعمال یا ہماری جانچ سے بچنے کی کوشش نہیں کر سکتے۔"] },
      { h: "4۔ سرمایہ کاری", list: ["آپ کسی پیشکش میں سبسکرائب کر کے اپنے بینک اکاؤنٹ سے ادائیگی کرتے ہیں۔ ٹرسٹی کو رقم ملنے کے بعد یونٹ جاری ہوتے ہیں۔", "پیشکش میں دکھائی گئی کولنگ آف مدت میں آپ مکمل رقم واپسی کے ساتھ سبسکرپشن واپس لے سکتے ہیں۔", "کرایہ اخراجات، فیس اور ودہولڈنگ ٹیکس کے بعد آپ کے اپنے تصدیق شدہ بینک اکاؤنٹ میں جاتا ہے۔", "یونٹ بیچنا یا منتقل کرنا صرف پیشکش کی دستاویزات کے مطابق ممکن ہے؛ ہو سکتا ہے کوئی خریدار نہ ہو۔"] },
      { h: "5۔ معلومات، مشورہ نہیں", p: ["پلیٹ فارم کا مواد، بشمول اے آئی تجزیہ کار، صرف معلومات ہے۔ یہ سرمایہ کاری، قانونی یا ٹیکس مشورہ نہیں۔ خود فیصلہ کریں یا مشیر سے پوچھیں۔"] },
      { h: "6۔ ریکارڈ", p: ["ہمارا لیجر، ٹرسٹی کا رجسٹر اور بلاک چین آپ کی ملکیت کا ریکارڈ ہیں۔ واضح غلطی ٹرسٹی کی منظوری سے درست کر کے آپ کو بتائی جا سکتی ہے۔"] },
      { h: "7۔ معطلی", p: ["قانون کے تقاضے پر، مثلاً اینٹی منی لانڈرنگ جائزے کے دوران، یا سرمایہ کاروں کے تحفظ کے لیے ہم اکاؤنٹ معطل یا ادائیگی روک سکتے ہیں۔"] },
      { h: "8۔ شکایات اور تنازعات", p: ["پہلے شکایات کا صفحہ استعمال کریں۔ مطمئن نہ ہوں تو ریگولیٹر کی شکایت سروس سے رجوع کر سکتے ہیں۔ پاکستانی قانون لاگو ہوگا۔"] },
    ],
  },
  privacy: {
    kicker: "قانونی",
    title: "رازداری کا نوٹس",
    intro: "ہم کیا جمع کرتے ہیں، کیوں، کتنی دیر رکھتے ہیں اور آپ کے حقوق۔ ہم کم سے کم ڈیٹا لیتے ہیں اور کبھی فروخت نہیں کرتے۔",
    draft: true,
    sections: [
      { h: "ہم کیا جمع کرتے ہیں", list: ["شناخت: نام، شناختی کارڈ، تاریخِ پیدائش، لائیونس چیک، نادرا سے تصدیق شدہ۔", "رابطہ: الرٹس کے لیے موبائل نمبر اور ای میل۔", "رقم: آپ کا ادائیگی کا بینک اکاؤنٹ اور آپ کی ادائیگیاں اور وصولیاں۔", "موزونیت: آمدنی، رقم کا ذریعہ اور سرمایہ کاری کا تجربہ۔", "تکنیکی: سائن ان ریکارڈ اور پاس کی کی پبلک کیز (آپ کا فنگر پرنٹ یا چہرہ کبھی نہیں)۔"] },
      { h: "ہم کیسے حفاظت کرتے ہیں", list: ["آپ کا پورا شناختی کارڈ اور فون نمبر ہمارے مرکزی ڈیٹا بیس میں نہیں: صرف آخری ہندسے اور ایک یک طرفہ فنگر پرنٹ۔", "نام، پتے اور دستاویزات انکرپٹڈ ہیں؛ ہر فائل کی اپنی کی ہے۔", "عملہ صرف اپنے کام کی حد تک دیکھتا ہے اور ہارڈویئر سیکیورٹی کی سے سائن ان کرتا ہے؛ حساس ڈیٹا تک ہر رسائی درج ہوتی ہے۔"] },
      { h: "ہم کیوں استعمال کرتے ہیں", p: ["قانون کے مطابق آپ کی تصدیق (اینٹی منی لانڈرنگ اور کے وائی سی)، آپ کی سرمایہ کاری چلانے اور ادائیگی، ٹیکس کی ذمہ داریوں، پلیٹ فارم کی حفاظت اور آپ کے سوالات کے جواب کے لیے۔"] },
      { h: "ہم کس سے شیئر کرتے ہیں", p: ["تصدیق کے لیے نادرا اور اسکریننگ فراہم کنندگان، ادائیگیوں کے لیے ٹرسٹی بینک، ٹیکس کے لیے ایف بی آر، اور قانون کے تقاضے پر ریگولیٹرز یا فنانشل مانیٹرنگ یونٹ۔ ہم آپ کا ڈیٹا کبھی فروخت یا کرایے پر نہیں دیتے۔"] },
      { h: "ہم کتنی دیر رکھتے ہیں", p: ["شناخت اور لین دین کا ریکارڈ اکاؤنٹ بند ہونے کے بعد اینٹی منی لانڈرنگ قانون کی مقررہ مدت تک رکھا جاتا ہے (تصدیق باقی)، پھر حذف۔"] },
      { h: "آپ کے حقوق", p: ["آپ اپنے ڈیٹا کی نقل، اس کی درستی یا اکاؤنٹ بند کرنے کی درخواست کر سکتے ہیں۔ کچھ ریکارڈ قانوناً بند ہونے کے بعد بھی رکھنے ہوتے ہیں۔ شکایات کے صفحے سے رابطہ کریں۔"] },
    ],
  },
  risks: {
    kicker: "سرمایہ کاری سے پہلے",
    title: "خطرات کا انکشاف",
    intro: "جائیداد کی قیمت گر سکتی ہے اور کرایہ رک سکتا ہے۔ سرمایہ کاری سے پہلے یہ خطرات پڑھیں اور صرف وہ رقم لگائیں جس کی جلد ضرورت نہ ہو۔",
    draft: true,
    sections: [
      { h: "اہم خطرات", list: ["قیمت: جائیداد کی قیمت گر سکتی ہے۔ آپ کو لگائی گئی رقم سے کم واپس مل سکتا ہے۔", "آمدنی: کرایہ دار جا سکتے ہیں یا ادائیگی نہ کریں؛ کرایہ کم یا دیر سے آ سکتا ہے۔ کرایے کی ضمانت نہیں۔", "لیکویڈیٹی: یونٹ بیچنا مشکل ہو سکتا ہے۔ نکلنا صرف پیشکش کی ونڈوز اور شرائط پر ممکن ہے اور ہو سکتا ہے خریدار نہ ہو۔", "ارتکاز: ہر پیشکش ایک جائیداد ہے۔ اپنی رقم کئی جگہ لگائیں۔", "اخراجات اور ٹیکس: مرمت، انتظامی فیس اور ٹیکس آپ کی آمدنی کم کرتے ہیں؛ ٹیکس قوانین بدل سکتے ہیں۔", "قانونی اور ریگولیٹری: قوانین، ریگولیٹر کے قواعد یا جائیداد کی قانونی حیثیت بدل سکتی ہے۔", "ٹیکنالوجی: پلیٹ فارم، بلاک چین یا کوئی فراہم کنندہ ناکام ہو سکتا ہے یا حملے کا شکار۔ ہم مضبوط حفاظتی اقدامات کرتے ہیں مگر کوئی نظام خطرے سے خالی نہیں۔", "پلیٹ فارم: پلیٹ فارم بند ہونے پر بھی ٹرسٹی جائیداد یونٹ ہولڈرز کے لیے رکھتا ہے، مگر ادائیگیوں اور فروخت میں تاخیر ہو سکتی ہے۔"] },
      { h: "آپ کا تحفظ", list: ["جائیداد اور رقم ایک آزاد ٹرسٹی کے پاس ہیں، پلیٹ فارم کے پاس نہیں۔", "ہر ادائیگی کے لیے دو افراد درکار ہیں (میکر چیکر)۔", "آپ کی ملکیت اور کرایہ تصدیق کے صفحے پر کوئی بھی جانچ سکتا ہے۔", "کولنگ آف مدت میں آپ واپس لے سکتے ہیں۔"] },
      { h: "ہر پیشکش", p: ["ہر پیشکش کا اپنا خطرات کا انکشاف اور پیشکش دستاویز ہے۔ سرمایہ کاری سے پہلے انہیں پڑھنا اور قبول کرنا لازمی ہے۔"] },
    ],
  },
  fees: {
    kicker: "اخراجات",
    title: "فیس اور ٹیکس",
    intro: "آپ کیا ادا کرتے ہیں اور کیا کٹتا ہے۔ فیس شیڈول کی منظوری تک نیچے کے اعداد پروٹوٹائپ کی مثالیں ہیں۔",
    draft: true,
    sections: [
      { h: "فیس (تصدیق باقی)", list: ["اکاؤنٹ کھولنا: مفت۔", "سرمایہ کاری: سبسکرپشن پر پلیٹ فارم فیس نہیں؛ پیشکش میں اجرا کے اخراجات ہو سکتے ہیں جو پہلے دکھائے جاتے ہیں۔", "جائیداد کا انتظام: تقسیم سے پہلے کرایے سے ادا؛ ہر ادائیگی کے حساب میں دکھایا جاتا ہے۔", "نکلنا / ریڈیمپشن: پیشکش کے مطابق فیس، تصدیق سے پہلے دکھائی جاتی ہے۔", "سرمایہ کاروں میں منتقلی: معمولی فیس، تصدیق سے پہلے دکھائی جاتی ہے۔"] },
      { h: "ٹیکس", list: ["کرایے سے قانون کی شرح پر ودہولڈنگ ٹیکس کٹتا ہے (فائلر اور نان فائلر کی شرح الگ)۔ آپ کو ریٹرن کے لیے ٹیکس سرٹیفکیٹ ملتا ہے۔", "یونٹ بیچنے پر سرمائے کے منافع پر آپ پر لاگو قواعد کے مطابق ٹیکس۔", "پلیٹ فارم پر دکھائی گئی شرحیں ٹیکس مشیروں کی تصدیق تک عارضی ہیں۔"] },
      { h: "کوئی چھپا خرچ نہیں", p: ["ہر کٹوتی ادائیگی کے حساب میں ہے، جسے آپ آن چین ریکارڈ سے ملا سکتے ہیں۔"] },
    ],
  },
  faq: {
    kicker: "مدد",
    title: "عام سوالات",
    intro: "سرمایہ کاروں کے عام سوالات کے مختصر جواب۔",
    draft: false,
    sections: [
      { h: "میں کس چیز کا مالک ہوں؟", p: ["ایک ٹرسٹ کے یونٹ جو ایک جائیداد کا مالک ہے۔ یونٹ ہمارے بلاک چین اور ٹرسٹی کے رجسٹر میں درج سیکیورٹی ٹوکن ہیں۔"] },
      { h: "شروع کرنے کے لیے کتنی رقم؟", p: ["ہر پیشکش اپنی کم از کم رقم دکھاتی ہے، عموماً تقریباً 1,000 روپے فی یونٹ سے۔"] },
      { h: "ادائیگی کیسے کروں؟", p: ["راست یا بینک ٹرانسفر سے، اپنے بینک اکاؤنٹ سے ٹرسٹی کے اکاؤنٹ میں، دکھائے گئے حوالے کے ساتھ۔ کسی اور کے اکاؤنٹ سے ادائیگی واپس کر دی جاتی ہے۔"] },
      { h: "کرایہ کب ملے گا؟", p: ["ہر پیشکش کے شیڈول پر، عموماً ماہانہ، اخراجات اور ودہولڈنگ ٹیکس کے بعد آپ کے تصدیق شدہ بینک اکاؤنٹ میں۔"] },
      { h: "کیا میں ارادہ بدل سکتا ہوں؟", p: ["جی ہاں، پیشکش کی کولنگ آف مدت میں سبسکرپشن واپس لے کر مکمل رقم واپس لے سکتے ہیں۔"] },
      { h: "میں کیسے بیچوں؟", p: ["پیشکش کی ایگزٹ ونڈوز میں (ٹرسٹ کو خالص اثاثہ قیمت پر واپسی) یا جہاں اجازت ہو، کسی دوسرے تصدیق شدہ سرمایہ کار کو منتقلی سے۔"] },
      { h: "پاس ورڈ کیوں نہیں؟", p: ["پاس کی (فنگر پرنٹ، چہرہ یا سیکیورٹی کی) چوری یا دوبارہ استعمال نہیں ہو سکتی۔ رقم کے کاموں پر پاس کی دوبارہ مانگی جاتی ہے۔"] },
      { h: "کیا یہ شریعت کے مطابق ہے؟", p: ["جن پیشکشوں پر شریعہ اسکرینڈ لکھا ہے ان کا شریعہ سرٹیفکیٹ ہے؛ ہر پیشکش دیکھیں۔"] },
      { h: "مجھے کیسے پتا چلے کہ میرے یونٹ اصلی ہیں؟", p: ["تصدیق کا صفحہ استعمال کریں: کوئی بھی ٹوکن کی تعداد ٹرسٹی رجسٹر سے، دستاویزات کے ہیش اور اپنا کرایے کا حق جانچ سکتا ہے۔"] },
      { h: "فون گم ہو جائے تو؟", p: ["آپ کے یونٹ آپ کی تصدیق شدہ شناخت سے جڑے ہیں، فون سے نہیں۔ نئی شناختی جانچ سے رسائی بحال کریں؛ نئے بینک اکاؤنٹ میں ادائیگی 72 گھنٹے بعد۔"] },
    ],
  },
  about: {
    kicker: "تعارف",
    title: "پراپرٹی ٹوکن کے بارے میں",
    intro: "ہم زیادہ پاکستانیوں کو آمدنی والی جائیداد میں حصہ دار بناتے ہیں، ہر قدم پر ثبوت کے ساتھ۔",
    draft: true,
    sections: [
      { h: "یہ کیسے بنا ہے", list: ["ہر جائیداد اور رقم ایک آزاد ٹرسٹی کے پاس ہے۔", "یونٹ ایک نجی، اجازت یافتہ بلاک چین پر ERC-3643 سیکیورٹی ٹوکن ہیں؛ ان کی حالت ہر 15 منٹ بعد ایک پبلک چین پر درج ہوتی ہے۔", "رقم یا ٹوکن کے ہر کام کے لیے دو افراد درکار ہیں اور یہ ایک ناقابلِ تبدیل لیجر میں لکھا جاتا ہے۔", "سرمایہ کار پاس کی سے، عملہ ہارڈویئر سیکیورٹی کی سے سائن ان کرتا ہے۔"] },
      { h: "موجودہ حیثیت", p: ["پروٹوٹائپ۔ ہم ایس ای سی پی ریگولیٹری سینڈ باکس کی تیاری کر رہے ہیں۔ ٹرسٹی معاہدہ، لائسنس اور آڈٹ ابھی مکمل ہو رہے ہیں؛ تب تک پلیٹ فارم حقیقی سرمایہ کاروں کے لیے کھلا نہیں۔"] },
      { h: "لائسنس اور شراکت دار", p: ["لائسنس نمبر، ٹرسٹی بینک اور آڈیٹرز تصدیق کے بعد یہاں درج ہوں گے۔"] },
    ],
  },
  reports: {
    kicker: "اعتماد",
    title: "آڈٹ اور شریعہ رپورٹس",
    intro: "آزاد رپورٹس یہاں شائع ہوں گی، ہر ایک کے SHA-256 کے ساتھ تاکہ آپ فائل جانچ سکیں۔",
    draft: false,
    sections: [
      { h: "اسمارٹ کنٹریکٹ آڈٹ", p: ["لانچ سے پہلے ہمارے کنٹریکٹس کے دو آزاد آڈٹ طے ہیں۔ ابھی شائع نہیں ہوئے۔"] },
      { h: "سیکیورٹی ٹیسٹ", p: ["لانچ سے پہلے ایک بیرونی پینیٹریشن ٹیسٹ طے ہے۔ ابھی شائع نہیں ہوا۔"] },
      { h: "مالیاتی گوشوارے", p: ["ہر ٹرسٹ کے آڈٹ شدہ گوشوارے سالانہ شائع ہوں گے۔"] },
      { h: "شریعہ سرٹیفکیٹ", p: ["ہر شریعہ اسکرینڈ پیشکش کا سرٹیفکیٹ جائیداد کے صفحے پر ہے؛ پلیٹ فارم کے شریعہ بورڈ کا سرٹیفکیٹ یہاں شائع ہوگا۔"] },
    ],
  },
  contact: {
    kicker: "مدد",
    title: "رابطہ اور شکایات",
    intro: "ہم مدد کے لیے حاضر ہیں۔ اکاؤنٹ سے متعلق کسی بھی بات کے لیے سائن ان کر کے اپنا سپورٹ حوالہ استعمال کریں تاکہ ہم شناختی کارڈ پوچھے بغیر آپ کو تلاش کر سکیں۔",
    draft: true,
    sections: [
      { h: "سوالات", p: ["سائن ان کر کے اکاؤنٹ کھولیں: وہاں آپ کا سپورٹ حوالہ ہے۔ سپورٹ سے رابطے پر یہ بتائیں۔"] },
      { h: "شکایات", list: ["سائن ان کر کے شکایات کھولیں اور درج کریں؛ آپ کو حوالہ (CMP-…) ملے گا۔", "ہم 2 کاروباری دنوں میں وصولی کی تصدیق اور 15 دنوں میں حل کی کوشش کرتے ہیں (تصدیق باقی)۔", "مطمئن نہ ہوں تو ریگولیٹر کی شکایت سروس سے رجوع کر سکتے ہیں۔"] },
      { h: "حفاظت", p: ["ہم کبھی فون، ایس ایم ایس یا ای میل پر آپ کی پاس کی، کوڈ یا پورا شناختی کارڈ نہیں مانگتے۔ کوئی مشکوک بات شکایات میں بتائیں۔"] },
    ],
  },
};

export function infoPage(lang: Lang, key: InfoKey): InfoPage {
  return new Map(Object.entries(lang === "ur" ? ur : en)).get(key) as InfoPage;
}

export function infoChrome(lang: Lang): InfoChrome {
  return lang === "ur" ? urChrome : enChrome;
}

export const INFO_PATHS: Readonly<Record<InfoKey, string>> = {
  terms: "/legal/terms",
  privacy: "/legal/privacy",
  risks: "/risks",
  fees: "/fees",
  faq: "/faq",
  about: "/about",
  reports: "/reports",
  contact: "/contact",
};
