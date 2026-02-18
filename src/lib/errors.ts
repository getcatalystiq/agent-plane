export class AppError extends Error {
  constructor(
    public code: string,
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
      },
    };
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super("not_found", 404, message);
  }
}

export class AuthError extends AppError {
  constructor(message = "Unauthorized") {
    super("unauthorized", 401, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super("forbidden", 403, message);
  }
}

export class BudgetExceededError extends AppError {
  constructor(message = "Monthly budget exceeded") {
    super("budget_exceeded", 403, message);
  }
}

export class ConcurrencyLimitError extends AppError {
  constructor(message = "Too many concurrent runs") {
    super("concurrency_limit", 429, message);
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super("validation_error", 400, message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super("conflict", 409, message);
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfter?: number) {
    super("rate_limited", 429, "Rate limit exceeded");
    if (retryAfter !== undefined) {
      (this as Record<string, unknown>).retryAfter = retryAfter;
    }
  }
}
