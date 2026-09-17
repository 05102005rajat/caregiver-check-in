/**
 * Single-line JSON logging, so Vercel's log search can filter on a specific household or
 * call instead of grepping prose. The question that actually gets asked in support is
 * "why didn't Mom get her call this morning?", and answering it means following one
 * parent_id/call_id across the scheduler, the dial, the webhook and the notification —
 * which only works if every one of those steps emits the same identifiers.
 *
 * Deliberately dependency-free and tiny: a logging library is not the interesting part
 * of this system, and console output is already captured in production.
 */
type Fields = Record<string, unknown>;

function emit(level: "info" | "warn" | "error", event: string, fields: Fields = {}) {
  const line = JSON.stringify({ level, event, ts: new Date().toISOString(), ...serializeErrors(fields) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Error objects JSON.stringify to `{}`, which silently loses the actual failure. */
function serializeErrors(fields: Fields): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value instanceof Error ? { message: value.message, stack: value.stack } : value;
  }
  return out;
}

export const log = {
  info: (event: string, fields?: Fields) => emit("info", event, fields),
  warn: (event: string, fields?: Fields) => emit("warn", event, fields),
  error: (event: string, fields?: Fields) => emit("error", event, fields),
};
