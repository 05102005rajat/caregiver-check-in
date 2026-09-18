import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

// Far enough ahead to be useful, not so far that a household silently never starts.
const MAX_DELAY_DAYS = 14;

const bodySchema = z.object({
  /** The caregiver states they have spoken to their parent about the calls. */
  confirmed: z.boolean(),
  /** Hold the first call until this instant. null clears any hold. */
  first_call_after: z.string().datetime().nullable(),
});

/**
 * Records that the caregiver has pre-warmed their parent, and optionally holds the first
 * call until a time they've agreed.
 *
 * `confirmed` is deliberately advisory. A caregiver cannot consent on their parent's
 * behalf — only Rosie can obtain that, on the call — and wiring this into the consent gate
 * would turn "I told my mum about this" into a consent record, which is precisely the
 * pattern that gets services like this sued. It exists to raise the odds the parent says
 * yes for real, not to substitute for their yes.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }
  const { confirmed, first_call_after: firstCallAfter } = parsed.data;

  if (firstCallAfter) {
    const limit = new Date(Date.now() + MAX_DELAY_DAYS * 24 * 60 * 60 * 1000);
    if (new Date(firstCallAfter) > limit) {
      return NextResponse.json({ error: `Can't hold the first call more than ${MAX_DELAY_DAYS} days` }, { status: 400 });
    }
  }

  // Scoped by caregiver_id, and RLS independently restricts this to their own parent —
  // there is no parent id in the body to tamper with.
  const { data, error } = await supabase
    .from("parents")
    .update({
      prewarm_confirmed_at: confirmed ? new Date().toISOString() : null,
      first_call_after: firstCallAfter,
    })
    .eq("caregiver_id", user.id)
    .select("id, prewarm_confirmed_at, first_call_after")
    .maybeSingle();

  if (error || !data) {
    log.error("prewarm.update_failed", { caregiver_id: user.id, err: error });
    return NextResponse.json({ error: error?.message ?? "No parent to update" }, { status: 500 });
  }

  log.info("prewarm.updated", { parent_id: data.id, confirmed, first_call_after: data.first_call_after });
  return NextResponse.json({ prewarm_confirmed_at: data.prewarm_confirmed_at, first_call_after: data.first_call_after });
}
