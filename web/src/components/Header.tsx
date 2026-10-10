import Link from "next/link";
import { logout } from "@/app/actions/auth";
import type { Dict, Lang } from "@/lib/i18n";
import { LangToggle } from "./LangToggle";

export function Header({ lang, t, userName }: { lang: Lang; t: Dict; userName: string | null }) {
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
        <div className="user">
          {userName ? (
            <>
              <Link href="/account">{userName}</Link>
              <form action={logout}>
                <button type="submit" className="linklike">
                  {t.logout}
                </button>
              </form>
            </>
          ) : (
            <Link href="/login">{t.navLogin}</Link>
          )}
        </div>
        <LangToggle lang={lang} />
      </div>
    </header>
  );
}
