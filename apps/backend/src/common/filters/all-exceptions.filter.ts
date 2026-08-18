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

    const message = exception instanceof Error ? exception.message : 'Internal server error';
    return { statusCode: 500, code: ERR_INTERNAL, message };
  }
}
