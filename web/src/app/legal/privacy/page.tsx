import type { Metadata } from "next";
import { InfoView } from "@/components/InfoPage";

export const metadata: Metadata = { title: "Privacy notice · Property Token" };

export default function Page() {
  return <InfoView page="privacy" />;
}
