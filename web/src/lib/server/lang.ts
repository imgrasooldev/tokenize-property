import { cookies } from "next/headers";
import { dictFor, type Dict, type Lang } from "../i18n";

export async function getLang(): Promise<Lang> {
  const value = (await cookies()).get("lang")?.value;
  return value === "ur" ? "ur" : "en";
}

export async function getDict(): Promise<{ lang: Lang; t: Dict }> {
  const lang = await getLang();
  return { lang, t: dictFor(lang) };
}
