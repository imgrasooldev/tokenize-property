import localFont from "next/font/local";

/**
 * Self-hosted fonts (the CSP allows font-src 'self' only; no external font services). Files are
 * the Latin and Arabic subsets of the @fontsource-variable packages, version 5.3.0, all under the
 * SIL Open Font License 1.1 (licences next to the files in src/fonts/).
 */
export const sans = localFont({
  src: "../fonts/inter-latin-wght-normal.woff2",
  weight: "100 900",
  variable: "--font-sans",
  display: "swap",
  fallback: ["system-ui", "Segoe UI", "Arial", "sans-serif"],
});

export const display = localFont({
  src: "../fonts/space-grotesk-latin-wght-normal.woff2",
  weight: "300 700",
  variable: "--font-display",
  display: "swap",
  fallback: ["system-ui", "Segoe UI", "Arial", "sans-serif"],
});

export const mono = localFont({
  src: "../fonts/jetbrains-mono-latin-wght-normal.woff2",
  weight: "100 800",
  variable: "--font-mono",
  display: "swap",
  // Used for small figures only; not worth a preload on every page.
  preload: false,
  fallback: ["ui-monospace", "Consolas", "monospace"],
});

/** Urdu (Nastaliq). Not preloaded: the browser fetches it only when Urdu text is shown in it. */
export const urdu = localFont({
  src: "../fonts/noto-nastaliq-urdu-arabic-wght-normal.woff2",
  weight: "400 700",
  variable: "--font-urdu",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  fallback: ["Noto Nastaliq Urdu", "Jameel Noori Nastaleeq", "Urdu Typesetting", "serif"],
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0897-08E1,U+08E3-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC",
    },
  ],
});
