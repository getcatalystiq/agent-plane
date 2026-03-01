import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getEnv, resetEnvCache } from "@/lib/env";

const VALID_ENV = {
  DATABASE_URL: "postgresql://localhost/test",
  ENCRYPTION_KEY: "0".repeat(64),
  ADMIN_API_KEY: "admin-key-123",
  AI_GATEWAY_API_KEY: "gateway-key-456",
  NODE_ENV: "test",
};

describe("getEnv", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    resetEnvCache();
  });

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    resetEnvCache();
  });

  it("returns parsed Env for valid environment", () => {
    Object.assign(process.env, VALID_ENV);
    const env = getEnv();
    expect(env.DATABASE_URL).toBe(VALID_ENV.DATABASE_URL);
    expect(env.ENCRYPTION_KEY).toBe(VALID_ENV.ENCRYPTION_KEY);
    expect(env.ADMIN_API_KEY).toBe(VALID_ENV.ADMIN_API_KEY);
    expect(env.AI_GATEWAY_API_KEY).toBe(VALID_ENV.AI_GATEWAY_API_KEY);
    expect(env.NODE_ENV).toBe("test");
  });

  it("throws when DATABASE_URL is missing", () => {
    const { DATABASE_URL, ...rest } = VALID_ENV;
    Object.assign(process.env, rest);
    delete process.env.DATABASE_URL;
    expect(() => getEnv()).toThrow("Environment validation failed");
  });

  it("throws when ENCRYPTION_KEY is wrong length (32 chars)", () => {
    Object.assign(process.env, { ...VALID_ENV, ENCRYPTION_KEY: "0".repeat(32) });
    expect(() => getEnv()).toThrow("Environment validation failed");
  });

  it("throws when ADMIN_API_KEY is missing", () => {
    const { ADMIN_API_KEY, ...rest } = VALID_ENV;
    Object.assign(process.env, rest);
    delete process.env.ADMIN_API_KEY;
    expect(() => getEnv()).toThrow("Environment validation failed");
  });

  it("throws when AI_GATEWAY_API_KEY is missing", () => {
    const { AI_GATEWAY_API_KEY, ...rest } = VALID_ENV;
    Object.assign(process.env, rest);
    delete process.env.AI_GATEWAY_API_KEY;
    expect(() => getEnv()).toThrow("Environment validation failed");
  });

  it("defaults NODE_ENV to development when not set", () => {
    const { NODE_ENV, ...rest } = VALID_ENV;
    Object.assign(process.env, rest);
    delete process.env.NODE_ENV;
    const env = getEnv();
    expect(env.NODE_ENV).toBe("development");
  });

  it("returns cached object on multiple calls", () => {
    Object.assign(process.env, VALID_ENV);
    const a = getEnv();
    const b = getEnv();
    expect(a).toBe(b);
  });

  it("re-reads env after resetEnvCache()", () => {
    Object.assign(process.env, VALID_ENV);
    const a = getEnv();
    resetEnvCache();
    const b = getEnv();
    expect(a).not.toBe(b);
  });
});
