import { beforeEach, describe, expect, it, vi } from "vitest";

// Every outbound channel is mocked: these tests exist so the dedupe and send order can be
// checked without a billed Twilio segment or a real database.
const sent: { to: string; body: string }[] = [];
vi.mock("@/lib/twilio", () => ({
  sendSms: vi.fn(async (to: string, body: string) => {
    sent.push({ to, body });
    return `SM${sent.length}`;
  }),
  TwilioSendError: class extends Error {},
  TWILIO_UNSUBSCRIBED: 21610,
}));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => "email-id") }));
vi.mock("@/lib/optout", () => ({ recordCarrierOptOut: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { notedFingerprint, notifyFamilyContacts } from "./notify";

type Row = Record<string, unknown>;

/**
 * Just enough of the Supabase query builder for notify.ts, over in-memory tables. `like`
 * is implemented with Postgres semantics (`%`, `_`, backslash escape) because the escaping
 * is part of what is under test.
 */
function fakeDb(tables: Record<string, Row[]>) {
  const likeToRegex = (pattern: string) => {
    let re = "";
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === "\\" && i + 1 < pattern.length) re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      else if (c === "%") re += ".*";
      else if (c === "_") re += ".";
      else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${re}$`, "s");
  };
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const q = {
      select: () => q,
      eq: (col: string, v: unknown) => (filters.push((r) => r[col] === v), q),
      like: (col: string, p: string) => (filters.push((r) => likeToRegex(p).test(String(r[col]))), q),
      not: (col: string, _op: string, _v: unknown) => (filters.push((r) => r[col] != null), q),
      or: () => q, // delivery_status: every fake row is undelivered-free
      gte: () => q,
      limit: () => q,
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      single: async () => ({ data: rows()[0] ?? null, error: null }),
      insert: async (row: Row) => {
        (tables[table] ??= []).push({ ...row, sent_at: new Date().toISOString() });
        return { error: null };
      },
      then: (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null }),
    };
    return q;
  };
  return { from } as never;
}

const SHARED = "+12025550100";
const household = (contactPhone: string) => ({
  parents: [{ id: "p1", caregiver_id: "cg1" }],
  caregivers: [{ id: "cg1", phone: SHARED, email: null }],
  family_contacts: [{ id: "c1", parent_id: "p1", phone: contactPhone, email: null, notify_on_concern: true }],
  sms_opt_ins: [] as Row[],
  messages: [] as Row[],
});

beforeEach(() => {
  sent.length = 0;
});

describe("notifyFamilyContacts with a caregiver copy", () => {
  const plain = "request:a visit on sunday";

  it("texts a number shared by the caregiver and a contact once, with the caregiver's copy", async () => {
    // Production's one household is exactly this shape. The two copies carry different
    // fingerprints, so without the noted-copy match and the caregiver-first order, that
    // person was texted twice.
    const db = fakeDb(household(SHARED));
    await notifyFamilyContacts(db, "p1", "notify_on_concern", "call1", "BODY", {
      fingerprint: plain,
      caregiverBody: { body: "BODY + note", fingerprint: notedFingerprint(plain, ["Aspirin"], "call1") },
    });
    expect(sent).toEqual([{ to: SHARED, body: "BODY + note" }]);
  });

  it("still texts a contact on a different number, without the note", async () => {
    // Control for the case above: the collapse must be about the shared number, not about
    // contacts in general.
    const db = fakeDb(household("+12025550199"));
    await notifyFamilyContacts(db, "p1", "notify_on_concern", "call1", "BODY", {
      fingerprint: plain,
      caregiverBody: { body: "BODY + note", fingerprint: notedFingerprint(plain, ["Aspirin"], "call1") },
    });
    expect(sent).toEqual([
      { to: SHARED, body: "BODY + note" },
      { to: "+12025550199", body: "BODY" },
    ]);
  });

  it("treats a later plain alert as a repeat of an earlier noted one", async () => {
    // Found by review: 9am request with a note, 6pm the same request with every dose
    // confirmed. The 6pm plain fingerprint did not match the 9am noted one, and the
    // caregiver got the same request twice inside the window meant to stop that.
    const tables = household("+12025550199");
    const db = fakeDb(tables);
    await notifyFamilyContacts(db, "p1", "notify_on_concern", "call1", "BODY", {
      fingerprint: plain,
      caregiverBody: { body: "BODY + note", fingerprint: notedFingerprint(plain, ["Aspirin"], "call1") },
    });
    sent.length = 0;
    await notifyFamilyContacts(db, "p1", "notify_on_concern", "call2", "BODY", { fingerprint: plain });
    expect(sent).toEqual([]);
  });

  it("does not treat a new unconfirmed dose as a repeat of an earlier plain alert", async () => {
    // The direction that must NOT collapse: the note is news for the caregiver.
    const tables = household("+12025550199");
    const db = fakeDb(tables);
    await notifyFamilyContacts(db, "p1", "notify_on_concern", "call1", "BODY", { fingerprint: plain });
    sent.length = 0;
    await notifyFamilyContacts(db, "p1", "notify_on_concern", "call2", "BODY", {
      fingerprint: plain,
      caregiverBody: { body: "BODY + note", fingerprint: notedFingerprint(plain, ["Aspirin"], "call1") },
    });
    expect(sent).toEqual([{ to: SHARED, body: "BODY + note" }]);
  });

  it("records an opted-out shared number once, not once per copy", async () => {
    // Found by review: the noted-copy match was added to the "already sent" lookup only.
    // The caregiver copy wrote its "opted out" row under the noted fingerprint, the contact
    // send looked for the plain one, missed it, and wrote a second row for the same person
    // and the same alert.
    const tables = household(SHARED);
    tables.sms_opt_ins.push({ phone: SHARED, revoked_at: new Date().toISOString() });
    const db = fakeDb(tables);
    await notifyFamilyContacts(db, "p1", "notify_on_concern", "call1", "BODY", {
      fingerprint: plain,
      caregiverBody: { body: "BODY + note", fingerprint: notedFingerprint(plain, ["Aspirin"], "call1") },
    });
    expect(sent).toEqual([]);
    const optOutRows = tables.messages.filter((m) => m.recipient === SHARED && m.status === "failed");
    expect(optOutRows).toHaveLength(1);
  });

  it("tells the caregiver about a later call's unconfirmed dose even when the request repeats", async () => {
    // Found by review: 9am and 7pm both carried the same request and left Metformin
    // unconfirmed. Keyed on the drug alone, the 7pm copy matched the 9am one and was
    // suppressed — and a request text replaces the standalone "Couldn't confirm", so the
    // caregiver heard nothing about the evening dose.
    const tables = household("+12025550199");
    const db = fakeDb(tables);
    const send = (callId: string) =>
      notifyFamilyContacts(db, "p1", "notify_on_concern", callId, "BODY", {
        fingerprint: plain,
        caregiverBody: { body: `BODY + note ${callId}`, fingerprint: notedFingerprint(plain, ["Metformin"], callId) },
      });
    await send("morning");
    sent.length = 0;
    await send("evening");
    // The caregiver gets the evening's note; the contact is still spared the repeat request.
    expect(sent).toEqual([{ to: SHARED, body: "BODY + note evening" }]);
  });

  it("does not let a wildcard in the alert text match an unrelated alert", async () => {
    // Fingerprints hold free text. Unescaped, `_` in one concern matched any character in
    // another, and would have suppressed it as a repeat.
    const tables = household("+12025550199");
    tables.messages.push({
      parent_id: "p1",
      recipient: SHARED,
      status: "sent",
      fingerprint: notedFingerprint("concern:fell xn the garden", ["Aspirin"], "call1"),
      sent_at: new Date().toISOString(),
    });
    const db = fakeDb(tables);
    await notifyFamilyContacts(db, "p1", "notify_on_concern", "call2", "BODY", { fingerprint: "concern:fell _n the garden" });
    expect(sent.map((m) => m.to)).toContain(SHARED);
  });
});
