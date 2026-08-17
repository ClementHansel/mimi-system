import {
  ERR_VALIDATION,
  ERR_AUTH_TOKEN_INVALID,
  ERR_FORBIDDEN,
  ERR_NOT_FOUND,
  ERR_CONFLICT,
  ERR_INTERNAL,
  type ErrorCode,
} from '@mimi/shared';

/**
 * Fallback machine `code` for exceptions that didn't already specify one
 * (CONTRACTS.md §0). Every branch below is a real `ErrorCode` member — none
 * of `ERR_BAD_REQUEST`/`ERR_UNAUTHORIZED`/`ERR_RATE_LIMITED`/`ERR_UNKNOWN`
 * exist in the closed union W1-B narrowed `ApiErrorShape.code` to, so this
 * maps each HTTP status to the closest real code instead of inventing new
 * ones — `ERR_INTERNAL` (added to the union for exactly this file) is the
 * one genuine last-resort case (a status this map doesn't recognize, or a
 * bare 5xx with no more specific code attached).
 */
export function defaultCodeForStatus(statusCode: number): ErrorCode {
  switch (statusCode) {
    case 400:
    case 422:
      return ERR_VALIDATION;
    case 401:
      return ERR_AUTH_TOKEN_INVALID;
    case 403:
      return ERR_FORBIDDEN;
    case 404:
      return ERR_NOT_FOUND;
    case 409:
      return ERR_CONFLICT;
    default:
      return ERR_INTERNAL;
  }
}
