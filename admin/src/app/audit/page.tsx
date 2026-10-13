import { forbidden, redirect } from "next/navigation";
import { SOURCE_LIST, sourcePermission } from "@/lib/routes";
import { requirePage } from "@/lib/server/session";

/** Opens the first audit trail the officer may read. */
export default async function AuditIndex() {
  const officer = await requirePage("officer", "/audit");
  const first = SOURCE_LIST.find((s) => officer.permissions.has(sourcePermission(s)));
  if (!first) forbidden();
  redirect(`/audit/${first}`);
}
