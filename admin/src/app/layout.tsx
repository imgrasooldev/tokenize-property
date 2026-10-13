import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { display, mono, sans } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "PT Control", template: "%s · PT Control" },
  description: "Property Token internal portals (officers only)",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#05070F",
  colorScheme: "dark",
};

// Every page reads the officer's session: never prerender or cache.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable} ${mono.variable}`}>
      <body>
        <div className="aurora" aria-hidden="true" />
        <div className="gridbg" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}
