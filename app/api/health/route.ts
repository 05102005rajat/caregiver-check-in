import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// If /api/cron/tick hasn't run successfully in this long, something's wrong with the
// external scheduler that's supposed to ping it every 5 minutes.
const STALE_AFTER_MINUTES = 15;

/**
 * Point an external monitor (e.g. UptimeRobot, cron-job.org's own alerting) at this route.
 * It returns a non-2xx status when the scheduler has gone quiet, so the caregiver finds
 * out the system stopped checking in — instead of silently assuming it's still working.
 */
export async function GET() {
  const db = createAdminClient();
  const { data } = await db.from("cron_heartbeat").select("last_tick_at").eq("id", true).single();

  const lastTickAt = data?.last_tick_at ? new Date(data.last_tick_at) : null;
  const minutesSinceLastTick = lastTickAt ? (Date.now() - lastTickAt.getTime()) / 60000 : null;
  const healthy = minutesSinceLastTick !== null && minutesSinceLastTick < STALE_AFTER_MINUTES;

  return NextResponse.json(
    { ok: healthy, lastTickAt, minutesSinceLastTick },
    { status: healthy ? 200 : 503 }
  );
}
