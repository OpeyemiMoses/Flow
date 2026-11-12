import { NextResponse } from "next/server";
import { fetchOneClickDryQuote } from "../../../../../../server/providers/one-click-adapter.ts";
import { resolveOneClickAssetId } from "../../../../../../domain/quote-discovery.ts";
import {
  formatAtomicToDisplay,
  parseDisplayToAtomic,
} from "../../../../../../domain/atomic-amounts.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await params;
    const body = await request.json();
    const {
      sourceDeploymentId,
      destinationDeploymentId,
      sourceDisplayAmount,
      recipientAddress,
      sourceDecimals = 6,
      destinationDecimals = 6,
    } = body;

    if (
      !sourceDeploymentId ||
      !destinationDeploymentId ||
      !sourceDisplayAmount ||
      !recipientAddress
    ) {
      return NextResponse.json(
        { ok: false, error: "Missing required quote parameters" },
        { status: 400 },
      );
    }

    const originAsset = resolveOneClickAssetId(sourceDeploymentId);
    const destinationAsset = resolveOneClickAssetId(destinationDeploymentId);

    if (!originAsset || !destinationAsset) {
      return NextResponse.json(
        {
          ok: false,
          error: "Selected route is not currently available via NEAR Intents",
        },
        { status: 400 },
      );
    }

    const amountAtomic = parseDisplayToAtomic(
      sourceDisplayAmount,
      sourceDecimals,
    ).toString();

    const dryQuote = await fetchOneClickDryQuote({
      originAsset,
      destinationAsset,
      swapType: "EXACT_INPUT",
      amountAtomic,
      refundTo: recipientAddress, // Safe refund fallback
      recipient: recipientAddress,
      deadlineSeconds: 900,
    });

    if (!dryQuote.ok || !dryQuote.amountOutAtomic) {
      return NextResponse.json(
        {
          ok: false,
          error:
            dryQuote.errorMessage ||
            "Failed to obtain NEAR Intents quote for this route",
        },
        { status: 400 },
      );
    }

    const recipientDisplayAmount = formatAtomicToDisplay(
      BigInt(dryQuote.amountOutAtomic),
      destinationDecimals,
    );

    const sourceNum = Number(sourceDisplayAmount);
    const destNum = Number(recipientDisplayAmount);
    const rate = sourceNum > 0 ? (destNum / sourceNum).toFixed(4) : "1.0000";

    return NextResponse.json({
      ok: true,
      quote: {
        amountInAtomic: dryQuote.amountInAtomic,
        amountOutAtomic: dryQuote.amountOutAtomic,
        recipientDisplayAmount,
        rate,
        estimatedTimeSeconds: dryQuote.timeEstimateSeconds ?? 60,
        intentFeeDisplay: dryQuote.fees?.withdrawFeeDisplay ?? "0.00",
        networkCostDisplay: dryQuote.fees?.networkGasEstimateDisplay ?? "$0.00",
        routeType: "NEAR_INTENTS_CROSS_CHAIN",
        canExecute: false, // Strict safety guard! Outgoing transfer execution is disabled
        executionDisabledReason:
          "Transfer preview only. Outgoing custody signing is disabled by security policy (FLOW_EXECUTION=disabled).",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Quote generation failed",
      },
      { status: 500 },
    );
  }
}
