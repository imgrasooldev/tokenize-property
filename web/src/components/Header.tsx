import Link from "next/link";
import type { Dict, Lang } from "@/lib/i18n";
import { LangToggle } from "./LangToggle";

export function Header({ lang, t }: { lang: Lang; t: Dict }) {
  return (
    <header className="header">
      <div className="container row">
        <Link href="/" className="brand">
          <span className="brand-mark" aria-hidden="true">PT</span>
          {t.brand}
        </Link>
        <nav className="nav" aria-label="Main">
          <Link href="/">{t.navProperties}</Link>
          <Link href="/portfolio">{t.navPortfolio}</Link>
          <Link href="/market">{t.navMarket}</Link>
        </nav>
        <span className="spacer" />
        <LangToggle lang={lang} />
      </div>
    </header>
  );
}
