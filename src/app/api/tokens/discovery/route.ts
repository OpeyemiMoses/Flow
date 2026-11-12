import { NextResponse } from "next/server";
import {
  getDiscoveredTokens,
  type TokenCapability,
} from "../../../../server/providers/near-intents-discovery.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const search = url.searchParams.get("search")?.trim().toLowerCase() ?? "";
    const network = url.searchParams.get("network")?.trim().toLowerCase() ?? "";
    const capability = url.searchParams.get(
      "capability",
    ) as TokenCapability | null;
    const forceRefresh = url.searchParams.get("refresh") === "true";

    const allTokens = await getDiscoveredTokens({
      forceRefresh,
      excludeWrapped: true, // User-facing wrapped tokens excluded per owner directive
    });

    let filtered = allTokens;

    if (network) {
      filtered = filtered.filter(
        (t) =>
          t.networkKey.toLowerCase() === network ||
          t.networkName.toLowerCase() === network,
      );
    }

    if (capability) {
      filtered = filtered.filter((t) => t.capabilities.includes(capability));
    }

    if (search) {
      filtered = filtered.filter(
        (t) =>
          t.symbol.toLowerCase().includes(search) ||
          t.name.toLowerCase().includes(search) ||
          t.networkName.toLowerCase().includes(search) ||
          (t.contractAddress &&
            t.contractAddress.toLowerCase().includes(search)),
      );
    }

    return NextResponse.json({
      ok: true,
      count: filtered.length,
      tokens: filtered,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Failed to fetch tokens",
      },
      { status: 500 },
    );
  }
}
