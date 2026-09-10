import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Server-to-server routes (cron, the future Vapi webhook) authenticate with their
  // own secrets, not the caregiver's session cookie, so they're excluded here.
  // /api/parents stays covered: it does rely on the cookie-based session.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/cron|api/vapi|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
