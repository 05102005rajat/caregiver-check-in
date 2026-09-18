import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * This endpoint is unauthenticated by design and keyed on a caller-supplied phone number.
 * That makes one property non-negotiable: it must never be able to *stop* a number's
 * alerts. It previously wrote `revoked_at: consented ? null : now`, so a single anonymous
 * POST with someone else's number and `consented: false` silently suppressed every alert
 * for that household — and the upsert also wiped their consent record on the way past.
 *
 * These tests assert the property rather than the implementation, so a future refactor
 * that reintroduces a revoking write fails here.
 */

type Row = Record<string, unknown>;
type DbError = { code: string; message: string } | null;
type Write = (row: Row, opts?: Record<string, unknown>) => Promise<{ error: DbError }>;

const upsert = vi.fn<Write>(async () => ({ error: null }));
const insert = vi.fn<Write>(async () => ({ error: null }));
const from = vi.fn(() => ({ upsert, insert }));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from }) }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { POST } = await import("./route");

function post(body: unknown) {
  return POST(
    new Request("https://example.com/api/sms-opt-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

/** Every field this route has written to the database across all calls. */
function allWrites(): Row[] {
  return [...upsert.mock.calls, ...insert.mock.calls].map((args) => args[0]);
}

/** The single row written by `mock`, failing loudly rather than silently passing on none. */
function soleWrite(mock: typeof upsert | typeof insert): Row {
  expect(mock).toHaveBeenCalledTimes(1);
  return mock.mock.calls[0]![0];
}

beforeEach(() => {
  upsert.mockClear();
  insert.mockClear();
  from.mockClear();
});

describe("POST /api/sms-opt-in", () => {
  it("never writes a revocation, whatever the caller asks for", async () => {
    await post({ phone: "+19495551234", consented: false });
    await post({ phone: "+19495551234", consented: true });

    expect(allWrites().length).toBeGreaterThan(0);
    for (const write of allWrites()) {
      // A truthy revoked_at from this endpoint is the vulnerability. Explicit null (on a
      // genuine re-opt-in) is fine.
      expect(write.revoked_at ?? null).toBeNull();
    }
  });

  it("declining does not upsert over an existing record's consent evidence", async () => {
    await post({ phone: "+19495551234", consented: false });

    // Insert-only: a conflict leaves the existing row untouched. An upsert here would let
    // an anonymous caller null out the consent text, version and timestamp that prove we
    // were permitted to text that number.
    expect(upsert).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledTimes(1);
    expect(soleWrite(insert)).not.toHaveProperty("consented_at");
  });

  it("treats an existing row as success when declining, rather than a 500", async () => {
    insert.mockResolvedValueOnce({ error: { code: "23505", message: "duplicate key" } });
    const res = await post({ phone: "+19495551234", consented: false });
    expect(res.status).toBe(200);
  });

  it("records consent with the server's wording, ignoring any supplied by the caller", async () => {
    await post({
      phone: "+19495551234",
      consented: true,
      consent_text: "I agree to be spammed forever",
      consent_version: 999,
    });

    const write = soleWrite(upsert);
    expect(write.consent_text).not.toContain("spammed");
    expect(write.consented_at).toBeTruthy();
  });

  it("normalises the phone to E.164 so it matches what Twilio sends to", async () => {
    await post({ phone: "(949) 555-1234", consented: true });
    expect(soleWrite(upsert).phone).toBe("+19495551234");
  });

  it("rejects an unparseable phone number instead of storing junk", async () => {
    const res = await post({ phone: "not a phone", consented: true });
    expect(res.status).toBe(400);
    expect(allWrites()).toHaveLength(0);
  });
});
