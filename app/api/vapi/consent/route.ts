import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Target of the record_consent Tool (Vapi "API Request" type — a direct HTTP call from
 * Vapi with a body it builds, not the message-envelope format the main /api/vapi/webhook
 * route handles). parent_id arrives as a Static Body Field templated from the call's
 * variableValues ({{parent_id}}, set in lib/dial.ts); consented is the argument the
 * assistant fills in based on the conversation.
 */
export async function POST(request: Request) {
  const secretHeader = request.headers.get("x-webhook-secret");
  if (secretHeader !== process.env.VAPI_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const parentId: string | undefined = body.parent_id;
  const consented = body.consented === true;

  if (!parentId) {
    return NextResponse.json({ error: "Missing parent_id" }, { status: 400 });
  }

  const db = createAdminClient();

  // The webhook secret alone would otherwise be a standing credential to set consent for
  // any parent_id. Requiring a currently-active call for that parent narrows a leaked
  // secret's blast radius to "during a call already in progress," not "at any time."
  const { data: activeCall } = await db
    .from("calls")
    .select("id")
    .eq("parent_id", parentId)
    .eq("status", "in_progress")
    .limit(1)
    .maybeSingle();
  if (!activeCall) {
    return NextResponse.json({ error: "No active call for this parent" }, { status: 409 });
  }

  if (consented) {
    // Don't clobber an existing timestamp (e.g. a duplicate tool invocation).
    await db.from("parents").update({ consent_given_at: new Date().toISOString() }).eq("id", parentId).is("consent_given_at", null);
  }

  return NextResponse.json({ ok: true, result: consented ? "Consent recorded, thank you." : "Understood." });
}
