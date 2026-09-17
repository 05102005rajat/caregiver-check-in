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

  // Explicit and ordered rather than relying on cascade rules, so this keeps working if a
  // future table is added without ON DELETE CASCADE — silently leaving transcripts behind
  // after telling someone their data was deleted would be the worst possible outcome here.
  // messages.parent_id was added later (0015) and backfilled only where call_id matched,
  // and messages.call_id has no ON DELETE rule — so a row with a null parent_id would
  // survive the sweep below and then break the calls delete with an FK violation. Clear
  // them by call id first.
  const { data: callIds } = await db.from("calls").select("id").eq("parent_id", parentId);
  if (callIds?.length) {
    const { error: orphanError } = await db.from("messages").delete().in(
      "call_id",
      callIds.map((c) => c.id as string)
    );
    if (orphanError) {
      log.error("delete.orphan_messages_failed", { parent_id: parentId, err: orphanError });
      return NextResponse.json({ error: "Deletion failed partway through — nothing further was removed" }, { status: 500 });
    }
  }

  const deletions = [
    db.from("messages").delete().eq("parent_id", parentId),
    db.from("calls").delete().eq("parent_id", parentId),
    db.from("medications").delete().eq("parent_id", parentId),
    db.from("appointments").delete().eq("parent_id", parentId),
    db.from("family_contacts").delete().eq("parent_id", parentId),
    db.from("watch_items").delete().eq("parent_id", parentId),
    db.from("escalation_rules").delete().eq("parent_id", parentId),
  ];
  for (const deletion of deletions) {
    const { error } = await deletion;
    if (error) {
      log.error("delete.child_failed", { parent_id: parentId, err: error });
      return NextResponse.json({ error: "Deletion failed partway through — nothing further was removed" }, { status: 500 });
    }
  }

  const { error: parentError } = await db.from("parents").delete().eq("id", parentId);
  if (parentError) {
    log.error("delete.parent_failed", { parent_id: parentId, err: parentError });
    return NextResponse.json({ error: "Deletion failed" }, { status: 500 });
  }

  // Verify rather than assume: this endpoint's whole promise is that nothing is left.
  // Counting only `calls` would have reported success while medications, contacts or —
  // worst of all — the alert bodies in `messages` survived. Selected by parent_id rather
  // than id because escalation_rules is keyed by parent_id and has no id column.
  let residual = 0;
  for (const table of ["messages", "calls", "medications", "appointments", "family_contacts", "watch_items", "escalation_rules"]) {
    const { count, error: countError } = await db.from(table).select("parent_id", { count: "exact", head: true }).eq("parent_id", parentId);
    if (countError || count) {
      log.error("delete.residual_rows", { parent_id: parentId, table, remaining: count, err: countError });
      residual += 1;
    }
  }
  if (residual > 0) {
    return NextResponse.json({ error: "Deletion incomplete — some data may remain. Please contact support." }, { status: 500 });
  }

  log.info("delete.completed", { parent_id: parentId, caregiver_id: user.id });
  return NextResponse.json({ deleted: true });
}
