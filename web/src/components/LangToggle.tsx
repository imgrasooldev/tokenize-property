"use client";

import { useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n";

export function LangToggle({ lang }: { lang: Lang }) {
  const router = useRouter();
  const set = (next: Lang) => {
    document.cookie = `lang=${next}; path=/; max-age=31536000; samesite=strict`;
    router.refresh();
  };
  return (
    <div className="lang" role="group" aria-label="Language">
      <button type="button" aria-pressed={lang === "en"} onClick={() => { set("en"); }}>
        EN
      </button>
      <button type="button" aria-pressed={lang === "ur"} onClick={() => { set("ur"); }} lang="ur">
        اردو
      </button>
    </div>
  );
}
