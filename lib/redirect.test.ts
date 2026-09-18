import { describe, expect, it } from "vitest";
import { safeNext } from "./redirect";

describe("safeNext", () => {
  it("allows an ordinary in-app path", () => {
    expect(safeNext("/dashboard")).toBe("/dashboard");
    expect(safeNext("/setup?step=2")).toBe("/setup?step=2");
  });

  it("falls back when absent or empty", () => {
    expect(safeNext(null)).toBe("/setup");
    expect(safeNext(undefined)).toBe("/setup");
    expect(safeNext("")).toBe("/setup");
  });

  it("rejects the userinfo trick that sends a freshly signed-in user to another site", () => {
    // `${origin}${next}` would build "https://app.example.com@evil.com" — everything
    // before the @ is credentials, so the browser navigates to evil.com.
    expect(safeNext("@evil.com")).toBe("/setup");
  });

  it("rejects protocol-relative, absolute and backslash URLs", () => {
    expect(safeNext("//evil.com")).toBe("/setup");
    expect(safeNext("https://evil.com")).toBe("/setup");
    expect(safeNext("http://evil.com")).toBe("/setup");
    expect(safeNext("/\\evil.com")).toBe("/setup");
  });
});
