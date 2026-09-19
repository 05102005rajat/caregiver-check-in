import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // /admin reads the prompt file at request time to diff it against the live Vapi
  // assistant. Without this the file is not traced into the serverless bundle, the read
  // fails in production, and the panel reports "could not verify" forever — honest, but
  // useless exactly where it matters.
  outputFileTracingIncludes: {
    "/admin": ["./prompts/vapi-system-prompt.txt"],
  },
};

export default nextConfig;
