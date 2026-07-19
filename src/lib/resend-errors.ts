// Shared Resend error classification, used by both the campaign batch path and
// the welcome single-send path so they retry/skip on identical rules.

// Errors that a queue redelivery can plausibly clear. Anything else is treated
// as terminal by the caller (marked failed + ack) so we never retry-storm.
export function isRetryableResendError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("name" in error)) {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return (
    name === "rate_limit_exceeded" ||
    name === "internal_server_error" ||
    name === "application_error" ||
    name === "concurrent_idempotent_requests"
  );
}

// Same idempotency key + a different payload → Resend returns 409. For a
// per-entity key (e.g. welcome/{contactId}) this means the message already went
// out under an earlier payload, so callers should treat it as "already sent",
// not retry.
export function isIdempotencyConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return (
    name === "invalid_idempotent_request" ||
    name === "invalid_idempotency_key" ||
    statusCode === 409
  );
}

export function stringifyResendError(error: unknown): string {
  if (!error) {
    return "Unknown Resend error";
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return JSON.stringify(error);
}
