import localFont from "next/font/local";

/**
 * Self-hosted fonts (the CSP allows font-src 'self' only; no external font services). Same files as
 * the website: Latin subsets of the @fontsource-variable packages 5.3.0, SIL Open Font License 1.1
 * (licences next to the files in src/fonts/). English only for now; Urdu comes later.
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
  fallback: ["ui-monospace", "Consolas", "monospace"],
});
