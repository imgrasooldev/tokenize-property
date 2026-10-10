import { SignUpForm } from "@/components/SignUpForm";
import { getDict } from "@/lib/server/lang";

export const dynamic = "force-dynamic";

export default async function SignUpPage() {
  const { t } = await getDict();
  return (
    <main className="container narrow">
      <h1>{t.signupTitle}</h1>
      <p className="lead">{t.signupBody}</p>
      <SignUpForm t={t} />
    </main>
  );
}
