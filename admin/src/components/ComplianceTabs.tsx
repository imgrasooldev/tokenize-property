const TABS: [string, string][] = [
  ["/compliance", "Dashboard"],
  ["/compliance/kyc", "KYC reviews"],
  ["/compliance/screening", "Sanctions & PEP"],
  ["/compliance/freezes", "Freezes"],
  ["/compliance/str", "STR cases"],
  ["/audit/compliance", "Audit trail"],
];

/** Sub-navigation of the compliance portal (Step 6c). */
export function ComplianceTabs({ current }: { current: string }) {
  return (
    <nav className="tabs" aria-label="Compliance">
      {TABS.map(([href, label]) => (
        <a key={href} href={href} aria-current={href === current ? "page" : undefined}>
          {label}
        </a>
      ))}
    </nav>
  );
}
