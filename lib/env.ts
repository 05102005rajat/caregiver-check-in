/**
 * Fails fast with a clear error naming the missing variable, instead of the request
 * silently doing the wrong thing (e.g. Vapi called with an undefined API key) and the
 * real cause only surfacing as a confusing downstream error at call time.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
