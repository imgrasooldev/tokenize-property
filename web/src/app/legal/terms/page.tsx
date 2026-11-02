import type { Metadata } from "next";
import { InfoView } from "@/components/InfoPage";

export const metadata: Metadata = { title: "Terms of use · Property Token" };

export default function Page() {
  return <InfoView page="terms" />;
}
