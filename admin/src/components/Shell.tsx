import type { ReactNode } from "react";
import { pkt } from "@/lib/format";
import { roleLabel, type Permission } from "@/lib/permissions";
import type { Officer } from "@/lib/server/session";

interface NavItem {
  href: string;
  label: string;
  icon: string;
  need: Permission | null;
  tag?: string;
}

const SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: "Operations",
    items: [
      { href: "/", label: "Overview", icon: "◉", need: "ops.read" },
      { href: "/approvals", label: "Approvals", icon: "✓", need: "approvals.read" },
      { href: "/approvals/property", label: "Property & KYB", icon: "⌂", need: "property.read" },
      { href: "/committees", label: "Investment committee", icon: "⚖", need: "property.read" },
      { href: "/approvals/offering", label: "Offering approvals", icon: "▣", need: "offering.read" },
      { href: "/audit", label: "Audit trail", icon: "⛓", need: null },
    ],
  },
  {
    title: "Compliance",
    items: [
      { href: "/compliance", label: "Dashboard", icon: "◎", need: "compliance.read" },
      { href: "/compliance/kyc", label: "KYC reviews", icon: "☑", need: "compliance.read" },
      { href: "/compliance/screening", label: "Sanctions & PEP", icon: "⚑", need: "compliance.read" },
      { href: "/compliance/freezes", label: "Freezes", icon: "⏸", need: "compliance.read" },
      { href: "/compliance/str", label: "STR cases", icon: "✉", need: "compliance.read" },
    ],
  },
  {
    title: "Cases",
    items: [
      { href: "/recovery", label: "Recovery & succession", icon: "⟲", need: "recovery.read" },
      { href: "/transfers", label: "Transfers", icon: "⇄", need: "transfer.read" },
      { href: "/exit", label: "Exit", icon: "⇥", need: "exit.read" },
    ],
  },
  {
    title: "Operations & tax",
    items: [
      { href: "/operations", label: "Property operations", icon: "₨", need: "operations.read" },
      { href: "/documents", label: "Document vault", icon: "▤", need: "operations.read" },
      { href: "/tax", label: "Withholding tax", icon: "%", need: "tax.read" },
      { href: "/tax/exports", label: "FBR filing exports", icon: "⇩", need: "tax.read" },
    ],
  },
  {
    title: "Trustee",
    items: [
      { href: "/trustee", label: "Overview", icon: "◈", need: "trustee.read" },
      { href: "/trustee/register", label: "Register", icon: "▦", need: "trustee.read" },
      { href: "/trustee/cosign", label: "Co-signing", icon: "✍", need: "trustee.read" },
      { href: "/trustee/properties", label: "Property acceptance", icon: "⌂", need: "trustee.read" },
      { href: "/trustee/distributions", label: "Distributions", icon: "⧗", need: "trustee.read" },
      { href: "/trustee/recon", label: "Reconciliation", icon: "≡", need: "trustee.read" },
      { href: "/trustee/recoveries", label: "Recoveries", icon: "↺", need: "trustee.read" },
    ],
  },
  {
    title: "Support",
    items: [
      { href: "/support", label: "Investor lookup", icon: "☎", need: "support.read" },
      { href: "/complaints", label: "Complaints", icon: "✉", need: "complaints.read" },
    ],
  },
  { title: "Administration", items: [{ href: "/officers", label: "Officers & roles", icon: "⚿", need: "officers.read" }] },
];

function canSeeAudit(o: Officer): boolean {
  return o.permissions.has("audit.read.ops") || o.permissions.has("audit.read.admin") || o.permissions.has("trustee.read");
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/** App frame: role-filtered navigation, page title, session facts and sign-out. */
export function Shell({
  officer,
  current,
  title,
  actions,
  children,
}: {
  officer: Officer;
  current: string;
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const visible = (i: NavItem) => (i.href === "/audit" ? canSeeAudit(officer) : i.need === null || officer.permissions.has(i.need));
  // The one nav entry for this page: the longest href that is the page itself or a parent of it.
  const active = SECTIONS.flatMap((s) => s.items)
    .filter((i) => current === i.href || (i.href !== "/" && current.startsWith(`${i.href}/`)))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return (
    <div className="app">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <aside className="side" aria-label="Portal">
        <a className="logo" href="/account">
          <svg width="24" height="24" viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <path d="M16 2l12 7v14l-12 7-12-7V9z" stroke="#22E3F0" strokeWidth="2" />
            <path d="M16 9l6 3.5v7L16 23l-6-3.5v-7z" fill="#8B5CF6" />
          </svg>
          PT Control
        </a>
        <nav aria-label="Main">
          {SECTIONS.map((s) => {
            const items = s.items.filter(visible);
            if (items.length === 0) return null;
            return (
              <div key={s.title}>
                <div className="sect">{s.title}</div>
                {items.map((i) => (
                  <a
                    key={i.href}
                    className="nav"
                    href={i.href}
                    aria-current={active === i.href ? "page" : undefined}
                  >
                    <span className="ico" aria-hidden="true">
                      {i.icon}
                    </span>
                    {i.label}
                    {i.tag ? (
                      <span className="tag" title={`Planned for Step ${i.tag}`}>
                        {i.tag}
                      </span>
                    ) : null}
                  </a>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="who">
          <a className="who-top" href="/account" style={{ color: "inherit" }}>
            <span className="av" aria-hidden="true">
              {initials(officer.name)}
            </span>
            <span>
              <b>{officer.name}</b>
              <span className="cy small" style={{ display: "block" }}>
                {officer.roles.map((r) => roleLabel(r)).join(" · ") || "no role"}
              </span>
            </span>
          </a>
          <form method="post" action="/api/auth/logout">
            <input type="hidden" name="csrf" value={officer.csrf} />
            <button className="btn block" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <div className="main">
        <header className="top">
          <h1>{title}</h1>
          <span className="env">INTERNAL · VPN/SSH ONLY</span>
          <span className="sp" />
          {actions}
          <span className="mono di small" title="Sessions end after 15 minutes without activity">
            session until {pkt(officer.expiresAt)}
          </span>
        </header>
        <main id="main" className="content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
