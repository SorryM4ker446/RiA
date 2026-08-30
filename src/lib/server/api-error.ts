import { ZodError } from "zod";

export type ApiErrorCode =
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UNAUTHORIZED"
  | "UPSTREAM_FAILED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "VALIDATION_ERROR"
  | "CONFIGURATION_ERROR"
  | "INTERNAL_ERROR";

export type ApiErrorPayload = {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
};

const DEFAULT_STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  RATE_LIMITED: 429,
  TIMEOUT: 504,
  UNAUTHORIZED: 401,
  UPSTREAM_FAILED: 502,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  VALIDATION_ERROR: 400,
  CONFIGURATION_ERROR: 500,
  INTERNAL_ERROR: 500,
};

export class ApiError extends Error {
  code: ApiErrorCode;
  status: number;
  details?: unknown;

  constructor(params: {
    code: ApiErrorCode;
    message: string;
    status?: number;
    details?: unknown;
  }) {
    super(params.message);
    this.name = "ApiError";
    this.code = params.code;
    this.status = params.status ?? DEFAULT_STATUS_BY_CODE[params.code];
    this.details = params.details;
  }
}

export function createApiErrorResponse(error: unknown, fallbackMessage = "Request failed") {
  if (error instanceof ApiError) {
    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      } satisfies ApiErrorPayload,
      { status: error.status },
    );
  }

  if (error instanceof ZodError) {
    return Response.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request body",
          details: error.flatten(),
        },
      } satisfies ApiErrorPayload,
      { status: 400 },
    );
  }

  return Response.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: fallbackMessage,
      },
    } satisfies ApiErrorPayload,
    { status: 500 },
  );
}

export function getApiErrorMessage(payload: unknown, fallback = "Request failed"): string {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object" &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
  ) {
    return payload.error.message;
  }

  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }

  return fallback;
}
