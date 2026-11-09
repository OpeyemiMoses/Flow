import { api } from "../../../../../../server/http.ts";
import { getPaymentAttemptStatus } from "../../../../../../server/payment-lifecycle.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; attemptId: string }> },
) {
  const { id, attemptId } = await context.params;
  return api(() => getPaymentAttemptStatus(request, id, attemptId));
}
