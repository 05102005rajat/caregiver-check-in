import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Deletes a household's data.
 *
 * The privacy policy tells people they can have their data deleted, so a mechanism has to
 * exist rather than depending on someone emailing and being manually obliged. Transcripts
 * of an elderly person's conversations are the most sensitive thing stored here, and
 * "we'll get to it" is not an acceptable answer for them.
 *
 * Requires typing the parent's name to confirm. Deletion is irreversible and takes the
 * call history with it, so an accidental click shouldn't be enough.
 */
const bodySchema = z.object({ confirm_name: z.string().min(1) });

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  // Read through the session client so RLS proves ownership, rather than trusting any id
  // from the request — the same invariant every service-role route here has to preserve.
  const { data: parent } = await supabase.from("parents").select("id, name").eq("caregiver_id", user.id).maybeSingle();
  if (!parent) {
    return NextResponse.json({ error: "No parent to delete" }, { status: 404 });
  }

  if (parsed.data.confirm_name.trim().toLowerCase() !== (parent.name as string).trim().toLowerCase()) {
    return NextResponse.json({ error: "Name doesn't match" }, { status: 400 });
  }

  const db = createAdminClient();
  const parentId = parent.id as string;

  // One transaction (migration 0028). This used to be eight sequential statements plus a
  // hand-rolled orphan sweep: any of them could fail halfway and leave the household partly
  // deleted after the UI had already said it was gone, and the residue check ran afterwards
  // so it could only report a problem that was already too late to undo. The far less
  // dangerous save path got a transaction in 0013; this one is the promise that matters.
  //
  // The function re-checks ownership itself rather than trusting parentId from here — it is
  // SECURITY DEFINER, so a caller reaching it with another household's id would otherwise
  // delete that household outright.
  const { error } = await db.rpc("delete_parent_household", {
    p_caregiver_id: user.id,
    p_parent_id: parentId,
  });

  if (error) {
    log.error("delete.failed", { parent_id: parentId, caregiver_id: user.id, err: error });
    return NextResponse.json(
      { error: "Deletion failed — nothing was removed. Please try again or contact support." },
      { status: 500 }
    );
  }

  log.info("delete.completed", { parent_id: parentId, caregiver_id: user.id });
  return NextResponse.json({ deleted: true });
}
