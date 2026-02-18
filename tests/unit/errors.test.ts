import { describe, it, expect } from "vitest";
import {
  AppError,
  NotFoundError,
  AuthError,
  ForbiddenError,
  BudgetExceededError,
  ConcurrencyLimitError,
  ValidationError,
  ConflictError,
  RateLimitError,
} from "@/lib/errors";

describe("Error Hierarchy", () => {
  it("AppError has correct properties", () => {
    const err = new AppError("test_error", 418, "Test message");
    expect(err.code).toBe("test_error");
    expect(err.statusCode).toBe(418);
    expect(err.message).toBe("Test message");
    expect(err.name).toBe("AppError");
    expect(err).toBeInstanceOf(Error);
  });

  it("AppError serializes to JSON", () => {
    const err = new AppError("test_error", 400, "Bad request");
    expect(err.toJSON()).toEqual({
      error: { code: "test_error", message: "Bad request" },
    });
  });

  it("NotFoundError has 404 status", () => {
    const err = new NotFoundError("Agent not found");
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe("not_found");
    expect(err).toBeInstanceOf(AppError);
  });

  it("AuthError has 401 status", () => {
    const err = new AuthError();
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe("unauthorized");
  });

  it("ForbiddenError has 403 status", () => {
    const err = new ForbiddenError();
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe("forbidden");
  });

  it("BudgetExceededError has 403 status", () => {
    const err = new BudgetExceededError();
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe("budget_exceeded");
  });

  it("ConcurrencyLimitError has 429 status", () => {
    const err = new ConcurrencyLimitError();
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe("concurrency_limit");
  });

  it("ValidationError has 400 status", () => {
    const err = new ValidationError("Invalid input");
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("validation_error");
  });

  it("ConflictError has 409 status", () => {
    const err = new ConflictError("Already exists");
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("conflict");
  });

  it("RateLimitError has 429 status", () => {
    const err = new RateLimitError(60);
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe("rate_limited");
  });
});
