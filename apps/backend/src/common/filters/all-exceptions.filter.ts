import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
// `ApiErrorShape`/`ErrorCode`/`ERROR_CODE_LIST` are published by @mimi/shared
// (packages/shared/src/types.ts, error-codes.ts). `ApiErrorShape.code` is now
// a closed `ErrorCode` union (coordinator-commissioned narrowing, mirroring
// `PermissionKey`) — a typo'd code is a compile error at a strongly-typed
// call site, but this filter also receives whatever arbitrary string ANY
// thrown exception's response body happens to carry (Wave 3/4 code that
// hasn't necessarily imported `ErrorCode` yet), so it additionally validates
// at runtime against `ERROR_CODE_LIST` before trusting one — see `isErrorCode` below.
import type { ApiErrorShape, ErrorCode } from '@mimi/shared';
import { ERROR_CODE_LIST, ERR_INTERNAL } from '@mimi/shared';
import { defaultCodeForStatus } from './error-code.util';
import { isPgError, mapPgError, pgErrorMessage } from './pg-error.util';

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODE_LIST as readonly string[]).includes(value);
}

/**
 * Global exception filter. Every error response — validation failures,
 * guard rejections, unhandled service errors — is normalized to CONTRACTS.md
 * §0's shape: `{ statusCode, code, message, details? }`. `code` is the
 * stable machine key the frontend's i18n layer resolves; `message` is a
 * developer-facing fallback, never trusted for user-facing text.
 *
 * Any thrown `HttpException` may already carry `{ code, message, details }`
 * in its response body (as `ForbiddenException({ code: ERR_FORBIDDEN, ... })`
 * does throughout `common/guards/**`) — that `code` wins verbatim IF it is a
 * real `ErrorCode` member (`isErrorCode`); otherwise (a stale/hand-typed
 * string that predates the closed union, or a third-party throw) this falls
 * back to a status-derived default rather than shipping an unrecognized code.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const shape = this.toErrorShape(exception);

    // A mapped database refusal (409/422/403) is logged at `warn` even though
    // it is not a 5xx: the response deliberately no longer carries the
    // driver's text, so this is the only place the constraint that actually
    // fired is recorded.
    if (shape.statusCode < 500 && isPgError(exception) && mapPgError(exception)) {
      this.logger.warn(
        `${request.method} ${request.originalUrl ?? request.url} → ${shape.statusCode} ${shape.code}: ${
          exception instanceof Error ? exception.message : String(exception)
        }`,
      );
    }

    if (shape.statusCode >= 500) {
      this.logger.error(
        `${request.method} ${request.originalUrl ?? request.url} → ${shape.statusCode}`,
        exception instanceof Error ? exception.stack : exception,
      );
    }

    response.status(shape.statusCode).json(shape);
  }

  private toErrorShape(exception: unknown): ApiErrorShape {
    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const body = exception.getResponse();

      if (typeof body === 'string') {
        return { statusCode, code: defaultCodeForStatus(statusCode), message: body };
      }

      if (typeof body === 'object' && body !== null) {
        const b = body as Record<string, unknown>;
        const rawMessage = b.message;
        const message =
          typeof rawMessage === 'string'
            ? rawMessage
            : Array.isArray(rawMessage)
              ? rawMessage.join('; ')
              : exception.message;
        const details = b.details ?? (Array.isArray(rawMessage) ? rawMessage : undefined);
        return {
          statusCode,
          code: isErrorCode(b.code) ? b.code : defaultCodeForStatus(statusCode),
          message,
          details,
        };
      }

      return { statusCode, code: defaultCodeForStatus(statusCode), message: exception.message };
    }

    // Raw database errors reach here (a constraint no service pre-checked).
    // `pg-error.util` turns the recognized ones into a real status and a
    // stable code, and — the point of the exercise — replaces the driver's
    // English/schema-flavoured text so it can never be shown to a user.
    if (isPgError(exception)) {
      const mapped = mapPgError(exception);
      if (mapped) {
        return {
          statusCode: mapped.statusCode,
          code: mapped.code,
          message: pgErrorMessage(exception),
          details: Object.keys(mapped.details).length > 0 ? mapped.details : undefined,
        };
      }
    }

    /**
     * A DOMAIN error: a plain `Error` subclass carrying a real `ErrorCode`,
     * thrown by a kernel that has no business importing `@nestjs/common` just
     * to pick an HTTP status. `StockLedgerService.post(…, 'strict')` raises two
     * of these (`StockInsufficientError`, `StockMovementValidationError`), and
     * both classes have carried a doc comment since they were written saying
     * they map "to HTTP 422 via `UnprocessableEntityException` — see the
     * exception filter".
     *
     * The filter had no such branch. They fell through to the 500 below, so
     * every dispatch of a Surat Jalan whose stock had gone short answered
     * `500 ERR_INTERNAL` — which the frontend renders as "Server sedang
     * bermasalah. Coba lagi beberapa saat.", telling the warehouse to retry
     * something that can never succeed, and logging a business refusal as a
     * server fault at `error` with a stack. A documented mapping that does not
     * exist is worse than an undocumented one: it reads as verified.
     *
     * Duck-typed on the `code` rather than importing the two classes, so the
     * kernel keeps its independence from `common/` and any future domain error
     * that follows the same convention is covered on arrival. 422 (not 400)
     * because the request was well-formed and the REFUSAL is semantic, which is
     * exactly what those doc comments specify.
     */
    if (exception instanceof Error && isErrorCode((exception as { code?: unknown }).code)) {
      return {
        statusCode: 422,
        code: (exception as unknown as { code: ErrorCode }).code,
        message: exception.message,
      };
    }

    const message = exception instanceof Error ? exception.message : 'Internal server error';
    return { statusCode: 500, code: ERR_INTERNAL, message };
  }
}
