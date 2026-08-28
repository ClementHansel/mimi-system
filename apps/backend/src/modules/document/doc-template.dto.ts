/**
 * Request DTOs for `doc-template.controller.ts`.
 *
 * WHY `PutDocTemplateDto` LISTS FIELDS BUT VALIDATES NONE OF THEM
 * -----------------------------------------------------------------
 * `validateDocTemplate` (`@mimi/shared`) already does full, authoritative
 * structural validation of a `DocTemplate` — geometry bounds, element-type
 * legality per kind, column/field-token closure, colour syntax, the lot (see
 * that file's header). Re-declaring even a fraction of those rules here with
 * `class-validator` decorators would be a second, independently-maintained
 * copy of the same contract — exactly the drift `validate.ts` exists to
 * prevent between the designer, the resolvers and the renderer. So this DTO
 * does not validate shape at all; `DocTemplateService.putTemplate` hands the
 * raw body straight to `validateDocTemplate` and raises `ERR_VALIDATION`
 * from that result, the same as `PutSettingDto`'s `@IsDefined() value!:
 * unknown` precedent in `modules/settings/settings.dto.ts`.
 *
 * The difference from that precedent is what gets whitelisted. `PutSettingDto`
 * wraps an arbitrary value under one `value` property, so one `@IsDefined()`
 * decorator is enough to keep `main.ts`'s global `ValidationPipe({
 * whitelist: true, forbidNonWhitelisted: true })` from stripping it. Here the
 * ticket requires the PUT body to BE the whole `DocTemplate` object, not a
 * wrapper — so whitelist would strip (and `forbidNonWhitelisted` would then
 * 400-reject) every one of its top-level keys unless each one is named on
 * this class. Every property below is therefore `@IsOptional()` — present
 * only so whitelist keeps it, asserting NOTHING about its type or presence,
 * because `validateDocTemplate` is the one place that decides whether a key
 * is missing, wrong-typed, or otherwise invalid. A property genuinely absent
 * from the body still reaches the service as `undefined`, which
 * `validateDocTemplate` already reports correctly (e.g.
 * `"template.paper 'undefined' is not a known paper size"`).
 */
import { IsOptional } from 'class-validator';

export class PutDocTemplateDto {
  @IsOptional()
  kind?: unknown;

  @IsOptional()
  paper?: unknown;

  @IsOptional()
  width?: unknown;

  @IsOptional()
  height?: unknown;

  @IsOptional()
  backgroundAttachmentId?: unknown;

  @IsOptional()
  elements?: unknown;

  @IsOptional()
  version?: unknown;
}
