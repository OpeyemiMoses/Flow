import { api } from "../../../../../server/http.ts";
import { discoverPaymentQuote } from "../../../../../server/quote-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return api(() => discoverPaymentQuote(request, id));
}
