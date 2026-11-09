import { notFound } from "next/navigation";
import { readPublicPaymentRequest } from "../../../server/payment-requests.ts";
import { CheckoutView } from "./checkout-view.tsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PayPageProps {
  params: Promise<{ id: string }>;
}

export default async function PayPage({ params }: PayPageProps) {
  const { id } = await params;

  let data;
  try {
    // Construct local request to query public payment request
    const dummyReq = new Request(`http://127.0.0.1/api/pay/${id}`);
    const res = await readPublicPaymentRequest(dummyReq, id);

    if (res.status === 404) {
      notFound();
    }

    data = await res.json();
  } catch {
    notFound();
  }

  return <CheckoutView request={data} />;
}
