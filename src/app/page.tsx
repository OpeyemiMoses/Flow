import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-4 px-8 py-16">
      <p className="text-sm font-medium tracking-wide text-teal-300">
        Multi-chain payment accounts
      </p>
      <div className="flow-actions">
        <Link href="/sign-in">Sign in to FLOW</Link>
        <Link href="/accounts">Open your accounts</Link>
      </div>
      <h1 className="text-5xl font-semibold tracking-tight">FLOW</h1>
      <p className="max-w-md text-lg text-slate-300">
        Pay from one network and settle in the recipient’s preferred asset and
        network.
      </p>
    </main>
  );
}
