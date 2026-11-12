import { NextResponse } from "next/server";
import { processAssistantQuery } from "../../../../../server/ai-assistant-service.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const prompt = body.prompt;

    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json(
        { ok: false, error: "Prompt is required" },
        { status: 400 },
      );
    }

    const response = await processAssistantQuery({
      accountId: id,
      prompt,
    });

    return NextResponse.json({
      ok: true,
      message: response,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Assistant query processing failed",
      },
      { status: 500 },
    );
  }
}
