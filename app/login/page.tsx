"use client";

import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

function LoginForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState("");
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/setup";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setError("");

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });

    if (error) {
      setStatus("error");
      setError(error.message);
    } else {
      setStatus("sent");
    }
  }

  if (status === "sent") {
    return (
      <div className="max-w-sm mx-auto mt-24 text-center">
        <h1 className="text-xl font-semibold mb-2">Check your email</h1>
        <p className="text-gray-600">
          We sent a sign-in link to <span className="font-medium">{email}</span>.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-sm mx-auto mt-24">
      <h1 className="text-xl font-semibold mb-4">Sign in</h1>
      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          type="email"
          required
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full border rounded px-3 py-2"
        />
        <button
          type="submit"
          disabled={status === "sending"}
          className="w-full bg-black text-white rounded px-3 py-2 disabled:opacity-50"
        >
          {status === "sending" ? "Sending..." : "Send magic link"}
        </button>
        {status === "error" && <p className="text-red-600 text-sm">{error}</p>}
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
