import Link from "next/link";
import { PublicPage } from "@/components/Shell";
import { getDict } from "@/lib/server/lang";

export default async function NotFound() {
  const { t } = await getDict();
  return (
    <PublicPage active="none">
      <main id="main" className="wrap center-page">
        <div className="glass auth-card">
          <div className="kicker">{"// 404"}</div>
          <h1 className="page-title grad">404</h1>
          <p className="lead-sm mu">{t.notFound}</p>
          <Link href="/" className="btn">
            {t.back}
          </Link>
        </div>
      </main>
    </PublicPage>
  );
}
