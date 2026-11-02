import type { MetadataRoute } from "next";

/** The public pages (no account pages). Used once the site is indexed at launch. */
const PATHS = ["/", "/properties", "/offerings", "/verify", "/faq", "/fees", "/risks", "/about", "/reports", "/contact", "/legal/terms", "/legal/privacy"];

export default function sitemap(): MetadataRoute.Sitemap {
  const base = (process.env.WEB_PUBLIC_ORIGIN ?? "http://localhost:3100").replace(/\/$/, "");
  return PATHS.map((p) => ({ url: `${base}${p}`, changeFrequency: p === "/" ? "daily" : "monthly" }));
}
