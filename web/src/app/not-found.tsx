import Link from "next/link";
import { getDict } from "@/lib/server/lang";

export default async function NotFound() {
  const { t } = await getDict();
  return (
    <main className="container narrow">
      <h1>404</h1>
      <p className="lead">{t.notFound}</p>
      <Link href="/" className="btn">
        {t.back}
      </Link>
    </main>
  );
}
