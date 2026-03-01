import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logger } from "@/lib/logger";

describe("logger output format", () => {
  let consoleSpy: { log: ReturnType<typeof vi.spyOn>; warn: ReturnType<typeof vi.spyOn>; error: ReturnType<typeof vi.spyOn> };

  beforeEach(() => {
    consoleSpy = {
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("info log outputs JSON with level, message, timestamp", () => {
    logger.info("test message");
    expect(consoleSpy.log).toHaveBeenCalledOnce();
    const output = JSON.parse(consoleSpy.log.mock.calls[0][0] as string);
    expect(output.level).toBe("info");
    expect(output.message).toBe("test message");
    expect(output.timestamp).toBeDefined();
  });

  it("timestamp is valid ISO 8601", () => {
    logger.info("time check");
    const output = JSON.parse(consoleSpy.log.mock.calls[0][0] as string);
    const date = new Date(output.timestamp);
    expect(date.toISOString()).toBe(output.timestamp);
  });

  it("context fields are merged into output", () => {
    logger.info("with context", { requestId: "abc-123", userId: "user-1" });
    const output = JSON.parse(consoleSpy.log.mock.calls[0][0] as string);
    expect(output.requestId).toBe("abc-123");
    expect(output.userId).toBe("user-1");
  });

  it("error level uses console.error", () => {
    logger.error("error msg");
    expect(consoleSpy.error).toHaveBeenCalledOnce();
    expect(consoleSpy.log).not.toHaveBeenCalled();
    expect(consoleSpy.warn).not.toHaveBeenCalled();
  });

  it("warn level uses console.warn", () => {
    logger.warn("warn msg");
    expect(consoleSpy.warn).toHaveBeenCalledOnce();
    expect(consoleSpy.log).not.toHaveBeenCalled();
    expect(consoleSpy.error).not.toHaveBeenCalled();
  });

  it("info level uses console.log", () => {
    logger.info("info msg");
    expect(consoleSpy.log).toHaveBeenCalledOnce();
    expect(consoleSpy.warn).not.toHaveBeenCalled();
    expect(consoleSpy.error).not.toHaveBeenCalled();
  });
});

describe("log level filtering", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("LOG_LEVEL=debug: debug messages appear", async () => {
    vi.resetModules();
    vi.stubEnv("LOG_LEVEL", "debug");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { logger: freshLogger } = await import("@/lib/logger");
    freshLogger.debug("test debug");
    expect(logSpy).toHaveBeenCalled();
    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output.level).toBe("debug");
  });

  it("LOG_LEVEL=info: debug suppressed, info appears", async () => {
    vi.resetModules();
    vi.stubEnv("LOG_LEVEL", "info");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { logger: freshLogger } = await import("@/lib/logger");
    freshLogger.debug("should not appear");
    expect(logSpy).not.toHaveBeenCalled();
    freshLogger.info("should appear");
    expect(logSpy).toHaveBeenCalledOnce();
  });

  it("LOG_LEVEL=warn: info and debug suppressed", async () => {
    vi.resetModules();
    vi.stubEnv("LOG_LEVEL", "warn");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { logger: freshLogger } = await import("@/lib/logger");
    freshLogger.debug("suppressed");
    freshLogger.info("suppressed");
    expect(logSpy).not.toHaveBeenCalled();
    freshLogger.warn("should appear");
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("LOG_LEVEL=error: only error appears", async () => {
    vi.resetModules();
    vi.stubEnv("LOG_LEVEL", "error");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { logger: freshLogger } = await import("@/lib/logger");
    freshLogger.debug("suppressed");
    freshLogger.info("suppressed");
    freshLogger.warn("suppressed");
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    freshLogger.error("should appear");
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it("invalid LOG_LEVEL falls back to info", async () => {
    vi.resetModules();
    vi.stubEnv("LOG_LEVEL", "bogus");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { logger: freshLogger } = await import("@/lib/logger");
    freshLogger.debug("suppressed");
    expect(logSpy).not.toHaveBeenCalled();
    freshLogger.info("should appear");
    expect(logSpy).toHaveBeenCalledOnce();
  });
});
