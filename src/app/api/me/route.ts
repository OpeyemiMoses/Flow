import { me } from "../../../server/accounts.ts";
import { api } from "../../../server/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return api(() => me(request));
}
