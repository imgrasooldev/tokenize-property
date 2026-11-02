import type { MetadataRoute } from "next";

/** Prototype: nothing is indexed until launch (the layout also sends noindex). */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
