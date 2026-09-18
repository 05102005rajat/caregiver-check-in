/**
 * Constrains a caller-supplied post-login `next` target to a path on this site.
 *
 * `next` rides in the magic-link URL, so it is attacker-controllable, and concatenating it
 * onto the origin is not the same as staying on this site: `next=@evil.com` builds
 * "https://app.example.com@evil.com", where everything before the @ is userinfo and the
 * browser navigates to evil.com — carrying a user who has just signed in straight off the
 * product, with the referrer to make the landing page look legitimate. "//evil.com",
 * "https://evil.com" and backslash variants are the same trick. Only a plain single-slash
 * path is allowed through; anything else falls back to the default landing page.
 */
export function safeNext(raw: string | null | undefined, fallback = "/setup"): string {
  if (!raw) return fallback;
  if (!raw.startsWith("/")) return fallback;
  // "//host" is protocol-relative and "/\host" is treated the same way by browsers.
  if (raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  return raw;
}
