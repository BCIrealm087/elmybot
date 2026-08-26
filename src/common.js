/**
 * Build a JSON response with the expected Discord response headers.
 */
export function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export const EXTERNAL_REQUEST_TIMEOUT_MS = 10_000;

export function withExternalRequestTimeout(init = {}) {
  if (init.signal) return init;
  return {
    ...init,
    signal: AbortSignal.timeout(EXTERNAL_REQUEST_TIMEOUT_MS)
  };
}

function boundedString(value, maxLength = 500) {
  return String(value ?? "").slice(0, maxLength);
}

export function errorDetails(error) {
  if (!(error instanceof Error)) {
    return { name: "UnknownError", message: boundedString(error || "Unknown error.") };
  }

  return {
    name: error.name,
    message: boundedString(error.message),
    ...(error.code !== undefined ? { code: boundedString(error.code, 100) } : {}),
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(error.metadata !== undefined ? { metadata: error.metadata } : {}),
    ...(error.cause instanceof Error ? {
      cause: {
        name: error.cause.name,
        message: boundedString(error.cause.message),
        ...(error.cause.code !== undefined
          ? { code: boundedString(error.cause.code, 100) }
          : {})
      }
    } : {})
  };
}

export function logError(event, context, error) {
  console.error(JSON.stringify({
    level: "error",
    event,
    ...context,
    error: errorDetails(error)
  }));
}

export function unknownErrorMessage(correlationId) {
  return `Unknown error. Reference: \`${correlationId}\`.`;
}
