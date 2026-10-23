import Link from "next/link";
import type { ReactNode } from "react";
import { logout } from "@/app/actions/auth";
import type { Dict, Lang } from "@/lib/i18n";
import { analystDict } from "@/lib/i18n-analyst";
import { exitDict } from "@/lib/i18n-exit";
import { offeringDict } from "@/lib/i18n-offering";
import { PROPERTIES } from "@/lib/properties";
import { investorById, type InvestorRow } from "@/lib/server/db";
import { getDict } from "@/lib/server/lang";
import { currentInvestorId } from "@/lib/server/session";
import { SearchShortcut } from "./analyst/SearchShortcut";
import { LangToggle } from "./LangToggle";
import { BlockHeight, ChainRail, type RailLabels } from "./live/Live";

const LIVE_SYMBOL = PROPERTIES[0]?.symbol ?? "GPF3";

export function Logo({ id, size = 28 }: { id: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M16 2l12 7v14l-12 7-12-7V9z" stroke={`url(#${id})`} strokeWidth="2" />
      <path d="M16 9l6 3.5v7L16 23l-6-3.5v-7z" fill={`url(#${id})`} />
      <defs>
        <linearGradient id={id} x1="0" x2="32" y1="0" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#22E3F0" />
          <stop offset="1" stopColor="#8B5CF6" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/** Small visible label for anything that is not live data or not working yet. */
export function Sample({ t, soon = false }: { t: Dict; soon?: boolean }) {
  return <span className={`chip sample ${soon ? "soon" : ""}`}>{soon ? t.comingSoonTag : t.sampleTag}</span>;
}

export function Spark() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z" />
    </svg>
  );
}

function railLabels(t: Dict): RailLabels {
  return {
    healthy: t.netHealthy,
    stale: t.netStale,
    validators: t.validators,
    block: t.block,
    blockTime: t.blockTime,
    ledger: t.ledgerChain,
    intact: t.intact,
    broken: t.broken,
    anchor: t.lastAnchor,
    vsNav: t.vsNav,
    anchorStandIn: t.anchorStandInLabel,
    anchorStandInTitle: t.anchorStandInTitle,
    anchored: t.anchorAnchored,
    anchorBlockN: t.anchorBlockN,
    ago: t.anchorAgo,
    unitMin: t.unitMin,
    unitHour: t.unitHour,
    late: t.anchorLate,
    failed: t.anchorFailed,
    pending: t.anchorPending,
    noneYet: t.anchorNoneYet,
    notAvailable: t.anchorNotAvailable,
    details: t.anchorDetails,
  };
}

/**
 * "Ask or search" entry (ADR 0015): a plain GET form to /search, so it works without JavaScript.
 * Questions get a grounded answer there; "/" or Ctrl/Cmd+K focuses the field. In the investor app
 * the question is about the signed-in investor's own portfolio (scope=portfolio).
 */
function AskBox({ lang, t, placeholder, portal = false }: { lang: Lang; t: Dict; placeholder?: string; portal?: boolean }) {
  const a = analystDict(lang);
  const id = portal ? "ask-portal" : "ask-site";
  return (
    <form role="search" action="/search" method="get" className="cmdk" aria-label={a.searchTitle}>
      <Spark />
      <label htmlFor={id} className="sr-only">
        {a.searchLabel}
      </label>
      <input
        id={id}
        name="q"
        type="search"
        className="cmdk-input"
        placeholder={placeholder ?? t.askOrSearch}
        maxLength={300}
        autoComplete="off"
        enterKeyHint="search"
        aria-keyshortcuts="/ Control+K Meta+K"
        data-search="header"
      />
      {portal && <input type="hidden" name="scope" value="portfolio" />}
      <SearchShortcut hint={a.searchHint} />
    </form>
  );
}

async function viewer(): Promise<{ lang: Lang; t: Dict; investor: InvestorRow | null }> {
  const { lang, t } = await getDict();
  const id = await currentInvestorId();
  const investor = id ? await investorById(id).catch(() => null) : null;
  return { lang, t, investor };
}

export type PublicKey = "explore" | "properties" | "offerings" | "market" | "portfolio" | "verify" | "none";

/** Public site header: live status rail plus the main navigation. */
export async function SiteHeader({ active, minimal = false }: { active: PublicKey; minimal?: boolean }) {
  const { lang, t, investor } = await viewer();
  const links: { key: PublicKey | "ai" | "proofs"; href: string; label: string }[] = [
    { key: "explore", href: "/", label: t.navExplore },
    { key: "properties", href: "/properties", label: t.navProperties },
    { key: "offerings", href: "/offerings", label: offeringDict(lang).navOfferings },
    { key: "market", href: "/market", label: t.navMarket },
    { key: "portfolio", href: "/portfolio", label: t.navPortfolio },
    { key: "verify", href: "/verify", label: t.navVerify },
    { key: "ai", href: "/#ai", label: t.navAi },
    { key: "proofs", href: "/#proof", label: t.navProofs },
  ];
  const nav = (
    <>
      {links.map((l) => (
        <Link key={l.key} href={l.href} className={l.key === active ? "on" : undefined} aria-current={l.key === active ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
    </>
  );
  return (
    <header className="site-head">
      {!minimal && <ChainRail lang={lang} l={railLabels(t)} />}
      <div className="wrap">
        <nav className="pubnav" aria-label={t.mainNav}>
          <Link href="/" className="logo">
            <Logo id="lg-head" />
            {t.brand}
          </Link>
          {!minimal && <div className="links">{nav}</div>}
          <span className="sp" />
          {!minimal && <AskBox lang={lang} t={t} />}
          <LangToggle lang={lang} />
          {investor ? (
            <div className="user">
              <Link href="/account" className="user-name">
                {investor.display_name}
              </Link>
              <form action={logout}>
                <button type="submit" className="linklike">
                  {t.logout}
                </button>
              </form>
              <Link href="/portfolio" className="btn small hide-sm">
                {t.launchApp}
              </Link>
            </div>
          ) : (
            <div className="user">
              <Link href="/login" className="btn secondary small">
                {t.navLogin}
              </Link>
              <Link href="/signup" className="btn small hide-sm">
                {t.getStarted}
              </Link>
            </div>
          )}
          {!minimal && (
            <details className="menu">
              <summary aria-label={t.menu}>
                <span aria-hidden="true">☰</span>
              </summary>
              <div className="menu-panel">
                {nav}
                <Link href="/search">{t.searchShort}</Link>
              </div>
            </details>
          )}
        </nav>
      </div>
    </header>
  );
}

export async function SiteFooter() {
  const { t } = await getDict();
  return (
    <footer className="pub">
      <div className="wrap">
        <div className="foot-grid">
          <div>
            <Link href="/" className="logo">
              <Logo id="lg-foot" size={24} />
              {t.brand}
            </Link>
            <p className="foot-note">{t.footerNote}</p>
          </div>
          <div>
            <h5>{t.footInvest}</h5>
            <ul>
              <li>
                <Link href="/properties">{t.navProperties}</Link>
              </li>
              <li>
                <Link href="/#returns">{t.returnsTitle}</Link>
              </li>
              <li>
                <Link href="/market">{t.navMarket}</Link>
              </li>
            </ul>
          </div>
          <div>
            <h5>{t.footTech}</h5>
            <ul>
              <li>
                <Link href="/verify">{t.navVerify}</Link>
              </li>
              <li>
                <Link href="/#proof">{t.navProofs}</Link>
              </li>
              <li>
                <Link href="/#ai">{t.navAi}</Link>
              </li>
              <li>
                <Link href="/#how">{t.howItWorks}</Link>
              </li>
            </ul>
          </div>
          <div>
            <h5>{t.footAccount}</h5>
            <ul>
              <li>
                <Link href="/signup">{t.getStarted}</Link>
              </li>
              <li>
                <Link href="/login">{t.navLogin}</Link>
              </li>
              <li>
                <Link href="/portfolio">{t.navPortfolio}</Link>
              </li>
            </ul>
          </div>
        </div>
        <p className="foot-fine">{t.verifyOnChain}</p>
      </div>
    </footer>
  );
}

/** Public page frame: header, content, footer. */
export function PublicPage({ active, children, minimal = false }: { active: PublicKey; children: ReactNode; minimal?: boolean }) {
  return (
    <>
      <SiteHeader active={active} minimal={minimal} />
      {children}
      <SiteFooter />
    </>
  );
}

export type PortalKey = "portfolio" | "invest" | "subscriptions" | "exit" | "market" | "rent" | "properties" | "account";

function initials(name: string): string {
  // Words that start with a letter only, so "Bob (demo)" gives "B", not "B(".
  const parts = name.trim().split(/\s+/).filter((w) => /^\p{L}/u.test(w));
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")).toUpperCase();
}

/** Investor app frame (signed in): sidebar navigation, top bar with live block and language. */
export async function PortalShell({
  active,
  title,
  titleExtra,
  children,
}: {
  active: PortalKey;
  title: ReactNode;
  titleExtra?: ReactNode;
  children: ReactNode;
}) {
  const { lang, t, investor } = await viewer();
  const items: { key: PortalKey; href: string; icon: string; label: string }[] = [
    { key: "portfolio", href: "/portfolio", icon: "◧", label: t.navPortfolio },
    { key: "invest", href: `/properties/${LIVE_SYMBOL}`, icon: "⬡", label: t.invest },
    { key: "subscriptions", href: "/subscriptions", icon: "◫", label: offeringDict(lang).navMySubs },
    { key: "exit", href: "/exit", icon: "⇲", label: exitDict(lang).navExit },
    { key: "market", href: "/market", icon: "⇄", label: t.navMarket },
    { key: "rent", href: "/portfolio#rent", icon: "₨", label: t.rentAndProofs },
    { key: "properties", href: "/properties", icon: "⌂", label: t.navProperties },
  ];
  return (
    <div className="app">
      <aside className="side" aria-label={t.investorNav}>
        <Link href="/" className="logo">
          <Logo id="lg-side" size={24} />
          {t.brand}
        </Link>
        <nav className="side-nav" aria-label={t.investorNav}>
          <div className="sect">{t.sectInvestor}</div>
          {items.map((i) => (
            <Link key={i.key} href={i.href} className={`nav ${i.key === active ? "on" : ""}`} aria-current={i.key === active ? "page" : undefined}>
              <span aria-hidden="true">{i.icon}</span> {i.label}
            </Link>
          ))}
          <div className="sect">{t.sectAccount}</div>
          <Link href="/account" className={`nav ${active === "account" ? "on" : ""}`} aria-current={active === "account" ? "page" : undefined}>
            <span aria-hidden="true">⚙</span> {t.navAccount}
          </Link>
          <span className="nav off" aria-disabled="true">
            <span aria-hidden="true">▤</span> {t.docsTax} <span className="chip sample soon">{t.comingSoonTag}</span>
          </span>
        </nav>
        {investor && (
          <div className="who">
            <div className="av" aria-hidden="true">
              {initials(investor.display_name)}
            </div>
            <div style={{ minInlineSize: 0 }}>
              <b className="who-name">{investor.display_name}</b>
              <div className={investor.kyc_status === "verified" ? "up" : "am"} style={{ fontSize: 11.5 }}>
                {investor.kyc_status === "verified" ? `✓ ${t.kycVerified}` : t.pending}
              </div>
              <form action={logout}>
                <button type="submit" className="linklike">
                  {t.logout}
                </button>
              </form>
            </div>
          </div>
        )}
      </aside>
      <div className="main">
        <div className="top">
          <h1>{title}</h1>
          {titleExtra}
          <span className="chip hide-sm">
            <span className="dot" aria-hidden="true" />
            {t.block} <BlockHeight lang={lang} />
          </span>
          <span className="sp" />
          <AskBox lang={lang} t={t} placeholder={t.askPortfolio} portal />
          <LangToggle lang={lang} />
          <Link href={`/properties/${LIVE_SYMBOL}`} className="btn small hide-sm">
            {t.invest}
          </Link>
        </div>
        <div className="content">{children}</div>
        <p className="portal-foot">{t.verifyOnChain}</p>
      </div>
    </div>
  );
}
