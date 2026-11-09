import { api } from "../../../../server/http.ts";
import { readPublicPaymentRequest } from "../../../../server/payment-requests.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return api(() => readPublicPaymentRequest(request, id));
}
