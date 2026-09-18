import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

// Bounded so a mistyped value can't silently mute a parent's check-ins for years —
// the caregiver would have no reason to revisit the page and would assume it was running.
const MAX_PAUSE_DAYS = 90;

const bodySchema = z.object({
  /** null resumes immediately; otherwise pause until this instant. */
  until: z.string().datetime().nullable(),
});

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }
  const { until } = parsed.data;

  if (until) {
    const limit = new Date(Date.now() + MAX_PAUSE_DAYS * 24 * 60 * 60 * 1000);
    if (new Date(until) > limit) {
      return NextResponse.json({ error: `Cannot pause for more than ${MAX_PAUSE_DAYS} days` }, { status: 400 });
    }
  }

  // Scoped by caregiver_id, and RLS independently restricts this to their own parent —
  // there's no parent id in the request body to tamper with in the first place.
  // Resuming clears paused_until, which erases any record that the gap was intentional.
  // The scheduler needs that record: without it, the first tick after a resume sees every
  // slot that already elapsed today as due-and-too-late and texts the family one "missed
  // check-in" per slot — a burst of alarms for a day nobody was ever going to be called on.
  const { data, error } = await supabase
    .from("parents")
    .update(until ? { paused_until: until } : { paused_until: null, resumed_at: new Date().toISOString() })
    .eq("caregiver_id", user.id)
    .select("id, paused_until, resumed_at")
    .maybeSingle();

  if (error || !data) {
    log.error("pause.update_failed", { caregiver_id: user.id, err: error });
    return NextResponse.json({ error: error?.message ?? "No parent to update" }, { status: 500 });
  }

  log.info("pause.updated", { parent_id: data.id, paused_until: data.paused_until });
  return NextResponse.json({ paused_until: data.paused_until });
}
