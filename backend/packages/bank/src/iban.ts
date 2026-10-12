/**
 * Pakistani IBANs: "PK" + 2 check digits + 4-letter bank code + 16 alphanumerics = 24 characters,
 * validated with the ISO 13616 mod-97 check. Spaces are allowed on input and removed.
 */
export interface Iban {
  iban: string;
  bankCode: string;
  last4: string;
}

export function parseIban(input: string): Iban {
  const iban = input.replace(/\s+/g, "").toUpperCase();
  if (!/^PK[0-9]{2}[A-Z]{4}[0-9A-Z]{16}$/.test(iban)) throw new Error("not a Pakistani IBAN (PK + 22 characters)");
  if (mod97(iban) !== 1) throw new Error("IBAN check digits are wrong");
  const last4 = iban.slice(-4);
  if (!/^[0-9]{4}$/.test(last4)) throw new Error("IBAN must end in four digits");
  return { iban, bankCode: iban.slice(4, 8), last4 };
}

/** Builds a valid IBAN from a bank code and a 16-character account number (tests and the mock bank). */
export function makeIban(bankCode: string, account: string): string {
  const base = `${bankCode}${account}PK00`;
  const check = 98 - mod97Raw(base);
  return `PK${String(check).padStart(2, "0")}${bankCode}${account}`;
}

function mod97(iban: string): number {
  return mod97Raw(iban.slice(4) + iban.slice(0, 4));
}

function mod97Raw(s: string): number {
  let r = 0;
  for (const ch of s) {
    const v = /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) r = (r * 10 + Number(d)) % 97;
  }
  return r;
}
