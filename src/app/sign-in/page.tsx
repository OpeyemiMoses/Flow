import { SignIn } from "./sign-in.tsx";

export const metadata = { title: "Sign in | FLOW", robots: { index: false } };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ issue?: string; notice?: string }>;
}) {
  const { issue, notice } = await searchParams;
  return <SignIn issue={issue} notice={notice} />;
}
