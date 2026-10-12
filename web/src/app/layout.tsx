import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { PulseProvider } from "@/components/live/PulseProvider";
import { getDict } from "@/lib/server/lang";
import { chainPulse } from "@/lib/server/pulse";
import { display, mono, sans, urdu } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Property Token · Investor prototype",
  description: "Prototype investor website on a local test network",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#05070F",
  colorScheme: "dark",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { lang, t } = await getDict();
  const pulse = await chainPulse();
  return (
    <html
      lang={lang}
      dir={lang === "ur" ? "rtl" : "ltr"}
      data-scroll-behavior="smooth"
      className={`${sans.variable} ${display.variable} ${mono.variable} ${urdu.variable}`}
    >
      <body>
        <div className="aurora" aria-hidden="true" />
        <div className="gridbg" aria-hidden="true" />
        <div className="banner" role="note">
          {t.demoBanner}
        </div>
        <PulseProvider initial={pulse}>{children}</PulseProvider>
      </body>
    </html>
  );
}
