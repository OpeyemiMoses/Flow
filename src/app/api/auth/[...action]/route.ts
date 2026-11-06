import { authRoute } from "../../../../server/auth/flows.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ action: string[] }> },
) {
  return authRoute(request, (await context.params).action.join("/"));
}

export const POST = GET;
