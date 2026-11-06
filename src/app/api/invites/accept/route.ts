import { api } from "../../../../server/http.ts";
import { acceptInvite } from "../../../../server/team.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return api(() => acceptInvite(request));
}
