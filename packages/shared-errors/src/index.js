"use strict";

class AppError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "AppError";
    this.code = options.code || "app_error";
    this.status = options.status || 500;
    this.retryable = options.retryable || false;
    this.details = options.details || null;
  }
}

class ValidationError extends AppError {
  constructor(message, details = null) {
    super(message, {
      code: "validation_error",
      status: 400,
      retryable: false,
      details,
    });
    this.name = "ValidationError";
  }
}

class AuthorizationError extends AppError {
  constructor(message = "Forbidden") {
    super(message, {
      code: "authorization_error",
      status: 403,
      retryable: false,
    });
    this.name = "AuthorizationError";
  }
}

class ExternalServiceError extends AppError {
  constructor(service, message, options = {}) {
    super(message, {
      code: options.code || "external_service_error",
      status: options.status || 502,
      retryable: options.retryable !== undefined ? options.retryable : true,
      details: {
        service,
        ...(options.details || {}),
      },
    });
    this.name = "ExternalServiceError";
    this.service = service;
  }
}

function toErrorResponse(error) {
  if (error instanceof AppError) {
    return {
      ok: false,
      error: error.message,
      code: error.code,
      details: error.details,
    };
  }

  return {
    ok: false,
    error: error.message || "Internal error",
    code: "internal_error",
  };
}

module.exports = {
  AppError,
  AuthorizationError,
  ExternalServiceError,
  ValidationError,
  toErrorResponse,
};
