import { ZodError } from "zod";

export type ApiErrorCode =
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "RANGE_NOT_SATISFIABLE"
  | "SERVICE_UNAVAILABLE"
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
  FORBIDDEN: 403,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RANGE_NOT_SATISFIABLE: 416,
  SERVICE_UNAVAILABLE: 503,
  UPSTREAM_FAILED: 502,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  VALIDATION_ERROR: 400,
  CONFIGURATION_ERROR: 503,
  INTERNAL_ERROR: 500,
};

export class ApiError extends Error {
  code: ApiErrorCode;
  status: number;
  details?: unknown;
  headers?: HeadersInit;

  constructor(params: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
    headers?: HeadersInit;
  }) {
    super(params.message);
    this.name = "ApiError";
    this.code = params.code;
    this.status = DEFAULT_STATUS_BY_CODE[params.code];
    this.details = params.details;
    this.headers = params.headers;
  }
}

export function normalizeApiError(error: unknown, fallbackMessage = "Request failed"): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof ZodError) {
    // Do not echo submitted values (which can contain credentials) in errors.
    return new ApiError({ code: "VALIDATION_ERROR", message: "Invalid request body", details: error.flatten() });
  }
  if (error instanceof Error && error.name === "PrismaClientKnownRequestError" && "code" in error) {
    if (error.code === "P2002") return new ApiError({ code: "CONFLICT", message: "A record with this identifier already exists" });
    if (error.code === "P2025") return new ApiError({ code: "NOT_FOUND", message: "Record was not found" });
    if (["P1008", "P2024"].includes(String(error.code))) return new ApiError({ code: "SERVICE_UNAVAILABLE", message: "Database is busy. Please try again later." });
  }
  if (error instanceof Error && error.name === "TimeoutError") return new ApiError({ code: "TIMEOUT", message: "Request timed out. Please try again later." });
  return new ApiError({ code: "INTERNAL_ERROR", message: fallbackMessage });
}

export function apiErrorPayload(error: ApiError): ApiErrorPayload {
  return { error: { code: error.code, message: error.message, details: error.details ?? {} } };
}

export function createApiErrorResponse(error: unknown, fallbackMessage = "Request failed") {
  const normalized = normalizeApiError(error, fallbackMessage);
  const headers = new Headers(normalized.headers);
  headers.set("Cache-Control", "no-store");
  return Response.json(apiErrorPayload(normalized), { status: normalized.status, headers });
}

export async function callUpstream<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof ApiError || (error instanceof Error && error.name === "TimeoutError")) throw error;
    throw new ApiError({ code: "UPSTREAM_FAILED", message: "Model service failed. Please try again later." });
  }
}
