import { onboard } from "../../../../server/accounts.ts";
import { api } from "../../../../server/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return api(() => onboard(request));
}
