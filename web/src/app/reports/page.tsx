import type { Metadata } from "next";
import { InfoView } from "@/components/InfoPage";

export const metadata: Metadata = { title: "Audit and Shariah reports · Property Token" };

export default function Page() {
  return <InfoView page="reports" />;
}
