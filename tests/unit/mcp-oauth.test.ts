import { describe, it, expect } from "vitest";
import {
  validateMetadataOrigin,
  generatePkceChallenge,
} from "@/lib/mcp-oauth";
import type { OAuthMetadata } from "@/lib/types";

const baseMetadata: OAuthMetadata = {
  issuer: "https://mcp.example.com",
  authorization_endpoint: "https://mcp.example.com/authorize",
  token_endpoint: "https://mcp.example.com/token",
  response_types_supported: ["code"],
};

describe("validateMetadataOrigin", () => {
  it("accepts metadata where all URLs share the same origin", () => {
    expect(() =>
      validateMetadataOrigin(baseMetadata, "https://mcp.example.com"),
    ).not.toThrow();
  });

  it("accepts metadata with registration_endpoint on same origin", () => {
    const metadata = {
      ...baseMetadata,
      registration_endpoint: "https://mcp.example.com/register",
    };
    expect(() =>
      validateMetadataOrigin(metadata, "https://mcp.example.com"),
    ).not.toThrow();
  });

  it("rejects metadata where token_endpoint has different origin", () => {
    const metadata = {
      ...baseMetadata,
      token_endpoint: "https://evil.com/token",
    };
    expect(() =>
      validateMetadataOrigin(metadata, "https://mcp.example.com"),
    ).toThrow(/different origin/);
  });

  it("rejects metadata where authorization_endpoint has different origin", () => {
    const metadata = {
      ...baseMetadata,
      authorization_endpoint: "https://evil.com/authorize",
    };
    expect(() =>
      validateMetadataOrigin(metadata, "https://mcp.example.com"),
    ).toThrow(/different origin/);
  });

  it("rejects metadata where registration_endpoint has different origin", () => {
    const metadata = {
      ...baseMetadata,
      registration_endpoint: "https://evil.com/register",
    };
    expect(() =>
      validateMetadataOrigin(metadata, "https://mcp.example.com"),
    ).toThrow(/different origin/);
  });

  it("ignores undefined registration_endpoint", () => {
    const { registration_endpoint: _, ...metadata } = {
      ...baseMetadata,
      registration_endpoint: undefined,
    };
    expect(() =>
      validateMetadataOrigin(metadata, "https://mcp.example.com"),
    ).not.toThrow();
  });
});

describe("generatePkceChallenge", () => {
  it("generates a code_verifier and code_challenge", async () => {
    const { codeVerifier, codeChallenge } = await generatePkceChallenge();
    expect(codeVerifier).toBeTruthy();
    expect(codeChallenge).toBeTruthy();
    expect(codeVerifier).not.toBe(codeChallenge);
  });

  it("generates URL-safe characters (no +, /, =)", async () => {
    const { codeVerifier, codeChallenge } = await generatePkceChallenge();
    expect(codeVerifier).not.toMatch(/[+/=]/);
    expect(codeChallenge).not.toMatch(/[+/=]/);
  });

  it("generates unique values each call", async () => {
    const a = await generatePkceChallenge();
    const b = await generatePkceChallenge();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
  });

  it("generates code_verifier of at least 43 characters (RFC 7636)", async () => {
    const { codeVerifier } = await generatePkceChallenge();
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
  });
});
