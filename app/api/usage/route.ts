import { NextResponse } from "next/server";
import { getUsageSnapshot } from "@/lib/usage/service";

export async function GET() {
  try {
    const snapshot = await getUsageSnapshot();

    return NextResponse.json(snapshot, {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Usage data is temporarily unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
}
