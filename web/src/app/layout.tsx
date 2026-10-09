import type { Metadata } from "next";
import { Inter, Noto_Naskh_Arabic } from "next/font/google";
import type { ReactNode } from "react";
import { Header } from "@/components/Header";
import { getDict } from "@/lib/server/lang";
import "./globals.css";

const latin = Inter({ subsets: ["latin"], variable: "--font-latin", display: "swap" });
const urdu = Noto_Naskh_Arabic({ subsets: ["arabic"], variable: "--font-urdu", display: "swap" });

export const metadata: Metadata = {
  title: "Property Token · Investor prototype",
  description: "Prototype investor website on a local test network",
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { lang, t } = await getDict();
  return (
    <html lang={lang} dir={lang === "ur" ? "rtl" : "ltr"} className={`${latin.variable} ${urdu.variable}`}>
      <body>
        <div className="banner">{t.demoBanner}</div>
        <Header lang={lang} t={t} />
        {children}
        <footer className="container footer">{t.verifyOnChain}</footer>
      </body>
    </html>
  );
}
