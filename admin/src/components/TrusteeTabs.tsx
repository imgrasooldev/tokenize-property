const TABS: [string, string][] = [
  ["/trustee", "Overview"],
  ["/trustee/register", "Register"],
  ["/trustee/cosign", "Co-signing"],
  ["/trustee/properties", "Property acceptance"],
  ["/trustee/distributions", "Distributions"],
  ["/trustee/recon", "Reconciliation"],
  ["/trustee/recoveries", "Recoveries"],
  ["/audit/trustee", "Audit trail"],
];

/** Sub-navigation of the trustee portal (Step 6d). */
export function TrusteeTabs({ current }: { current: string }) {
  return (
    <nav className="tabs" aria-label="Trustee">
      {TABS.map(([href, label]) => (
        <a key={href} href={href} aria-current={href === current ? "page" : undefined}>
          {label}
        </a>
      ))}
    </nav>
  );
}
